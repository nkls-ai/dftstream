package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/nkls-ai/dftstream/internal/auth"
	"github.com/nkls-ai/dftstream/internal/cliui"
)

// linkStart is the backend's response to /cli/link/start (RFC 8628-shaped).
// DeviceCode is the CLI-held secret used to poll for tokens — it must never
// be printed or placed in a URL. UserCode is the short code the human sees
// and approves in the UI; it can target an approval but cannot yield tokens.
type linkStart struct {
	DeviceCode string `json:"deviceCode"`
	UserCode   string `json:"userCode"`
	VerifyPath string `json:"verifyPath"`
	// Seconds to wait between polls; 0 means use the default.
	Interval int `json:"interval"`
}

// linkApproval is the backend's response to /cli/link/poll once the
// user has approved the code in the UI.
type linkApproval struct {
	Status         string `json:"status"`
	AccessToken    string `json:"accessToken"`
	RefreshToken   string `json:"refreshToken"`
	OrganizationID string `json:"organizationId"`
	// Display name and slug of the bound org; empty from a backend that
	// predates them, in which case the id is shown instead.
	OrganizationName string `json:"organizationName"`
	OrganizationSlug string `json:"organizationSlug"`
}

// orgLabel names the org this login acts in, as the approval page did:
// "Name (slug)" when the backend sent both, else whatever it did send.
func (a linkApproval) orgLabel() string {
	name := strings.TrimSpace(a.OrganizationName)
	slug := strings.TrimSpace(a.OrganizationSlug)
	switch {
	case name != "" && slug != "" && !strings.EqualFold(name, slug):
		return fmt.Sprintf("%s (%s)", name, slug)
	case name != "":
		return name
	case slug != "":
		return slug
	default:
		return a.OrganizationID
	}
}

// defaultPollInterval is used when the backend doesn't advertise one. The
// server enforces its own floor and answers HTTP 429 `slow_down` below it.
const defaultPollInterval = 3 * time.Second

// LoginCmd implements `dftstream login` using the browser-link flow: the CLI
// asks the backend for a device-code/user-code pair, the user approves the
// short user code in the signed-in DFTStream UI (picking which org the CLI
// should act in), and the CLI polls with its secret device code until it can
// store the returned tokens. This is provider-agnostic — it works whether the
// human logs into the UI via convex-auth or Clerk.
func LoginCmd(args []string) int {
	trackerURL, uiURL, err := parseLoginFlags(args)
	if err != nil {
		return exitCodeFor(err)
	}

	// A set machine token would shadow whatever this login stores (resolveAuth
	// prefers DFTSTREAM_TOKEN over credentials.json). Logging in is still
	// allowed — the user may be setting up their interactive account for other
	// shells — but silently ignoring the result would be baffling.
	if auth.MachineTokenFromEnv() != "" {
		fmt.Fprintf(os.Stderr, "warning: %s is set and takes precedence over stored credentials; the login you are about to store will be ignored in any shell where it remains set.\n", auth.EnvMachineToken) //nolint:errcheck — write to stderr is best-effort
	}

	site := auth.SiteURL(resolveTrackerURL(trackerURL))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	start, err := startCLILink(ctx, site)
	if err != nil {
		return exitCodeFor(err)
	}
	printApprovalPrompt(os.Stderr, uiURL, start)

	approval, err := awaitLinkApproval(ctx, site, start)
	if err != nil {
		return exitCodeFor(err)
	}
	return persistLoginCredentials(approval)
}

func parseLoginFlags(args []string) (trackerURL, uiURL string, err error) {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var (
		uiFlag   = fs.String("ui-url", "", "DFTStream UI base URL, used to print the approval link")
		showHelp = fs.Bool("help", false, "show help")
		backend  backendFlags
	)
	backend.registerTrackerURL(fs)
	fs.Usage = func() {
		cliui.Title(os.Stderr, "dftstream login")
		fmt.Fprintf(os.Stderr, "\nUsage:\n  dftstream login [--ui-url https://dftstream.example]\n  dftstream logout\n\nFlags:\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return "", "", exitStatus(2)
	}
	if *showHelp {
		fs.Usage()
		return "", "", exitStatus(0)
	}
	return backend.trackerURL, *uiFlag, nil
}

// startCLILink asks the backend for a device-code/user-code pair.
func startCLILink(ctx context.Context, site string) (linkStart, error) {
	startRaw, status, err := auth.PostJSON(ctx, site+"/cli/link/start", map[string]any{})
	if err != nil {
		fix := startFailureFix(status, startRaw, site)
		cliui.Error(os.Stderr, fmt.Sprintf("could not start login: %v", err), fix)
		return linkStart{}, exitStatus(1)
	}
	var start linkStart
	if err := json.Unmarshal(startRaw, &start); err != nil || start.DeviceCode == "" || start.UserCode == "" {
		cliui.Error(os.Stderr, "backend did not return a login code", "Confirm the deployment has auth (http.ts /cli/link) configured.")
		return linkStart{}, exitStatus(1)
	}
	return start, nil
}

// startFailureFix is the fix line for a failed /cli/link/start: it depends
// on who can act on the failure.
func startFailureFix(status int, raw []byte, site string) string {
	switch {
	case auth.IsBackendMisconfigured(status, raw):
		// Reachable, but it cannot mint tokens (JWT_PRIVATE_KEY unset): only
		// the deployment's operator can fix that.
		return "The deployment cannot sign CLI tokens; its operator must configure it (see docs/auth.md)."
	case status == http.StatusNotFound:
		// The route exists on every deployment with this backend; a 404
		// means the request reached something that is not its site origin.
		return fmt.Sprintf("%s is not the backend's HTTP-actions (site) origin. Set %s to it (for a local backend it is usually the tracker port + 1).", site, auth.EnvSiteURL)
	default:
		return "Check the tracker URL and that the backend is reachable."
	}
}

// printApprovalPrompt tells the user how to approve the login — as a clickable
// link when a UI base URL is known, otherwise as the raw user code. Only the
// short USER code is ever shown or embedded in the URL; the device code is the
// session secret and stays between this process and the backend.
func printApprovalPrompt(w io.Writer, uiURLFlag string, start linkStart) {
	base := strings.TrimRight(resolve(uiURLFlag, "DFTSTREAM_UI_URL", ""), "/")
	if base != "" {
		fmt.Fprintf(w, "\nOpen this URL in your browser to approve the CLI:\n\n  %s%s\n\nand confirm the code shown is:  %s\n\n", base, start.VerifyPath, start.UserCode)
	} else {
		fmt.Fprintf(w, "\nOpen the DFTStream UI, go to \"Connect CLI\", and approve code:\n\n  %s\n\n(Tip: pass --ui-url to print a clickable link.)\n\n", start.UserCode)
	}
	fmt.Fprintln(w, "Waiting for approval…")
}

// awaitLinkApproval polls the backend with the secret device code until the
// link is approved or the overall login deadline passes. Honors the server's
// advertised interval and backs off on HTTP 429 (RFC 8628 `slow_down`).
// Transient failures keep polling, but the last one is named if the deadline
// passes — a backend that answers 5xx for five minutes is not "waiting for
// approval".
func awaitLinkApproval(ctx context.Context, site string, start linkStart) (linkApproval, error) {
	interval := time.Duration(start.Interval) * time.Second
	if interval <= 0 {
		interval = defaultPollInterval
	}
	var lastErr error
	for {
		select {
		case <-ctx.Done():
			msg := "login timed out waiting for approval"
			if lastErr != nil {
				msg += fmt.Sprintf(" (last error: %v)", lastErr)
			}
			cliui.Error(os.Stderr, msg, "Run `dftstream login` again.")
			return linkApproval{}, exitStatus(1)
		case <-time.After(interval):
		}
		pollRaw, status, err := auth.PostJSON(ctx, site+"/cli/link/poll", map[string]any{"deviceCode": start.DeviceCode})
		switch {
		case err != nil && status == 0:
			// Transport failure — transient; keep polling until the deadline.
			lastErr = err
			continue
		case status == http.StatusTooManyRequests:
			// Server says slow_down: widen the gap before the next poll.
			interval += 2 * time.Second
			continue
		case status == http.StatusNotFound || status == http.StatusGone:
			// The link is gone for good (expired, swept, or already used);
			// no amount of further polling will change that.
			cliui.Error(os.Stderr, "login link expired or was already used", "Run `dftstream login` again.")
			return linkApproval{}, exitStatus(1)
		case status == http.StatusConflict:
			// Approved but not bound to a user/org — the handshake is dead.
			cliui.Error(os.Stderr, fmt.Sprintf("login link could not be completed: %v", err), "Run `dftstream login` again.")
			return linkApproval{}, exitStatus(1)
		case auth.IsBackendMisconfigured(status, pollRaw):
			// The backend itself says it cannot mint tokens (e.g. no
			// JWT_PRIVATE_KEY): retrying for five minutes cannot help.
			cliui.Error(os.Stderr, "the backend cannot issue CLI tokens: "+auth.BackendError(pollRaw), "Ask the deployment operator to configure CLI token signing (JWT_PRIVATE_KEY / CONVEX_SITE_URL), see docs/auth.md.")
			return linkApproval{}, exitStatus(1)
		case err != nil:
			// Other HTTP errors (proxy hiccup, mid-deploy 5xx) — treat as
			// transient; the overall deadline bounds this.
			lastErr = err
			continue
		}
		var poll linkApproval
		if err := json.Unmarshal(pollRaw, &poll); err != nil {
			// A malformed body from a flaky proxy; retry until the deadline.
			lastErr = fmt.Errorf("malformed poll response: %w", err)
			continue
		}
		if poll.Status != "approved" {
			continue
		}
		return poll, nil
	}
}

func persistLoginCredentials(approval linkApproval) int {
	if err := auth.SaveCredentials(auth.Credentials{
		Method:       auth.MethodBrowserLink,
		AccessToken:  approval.AccessToken,
		RefreshToken: approval.RefreshToken,
		OrgID:        approval.OrganizationID,
	}); err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not save credentials: %v", err), "Check permissions on the credentials directory (or set DFTSTREAM_CREDENTIALS).")
		return 1
	}
	title := "logged in"
	if org := approval.orgLabel(); org != "" {
		title += " to organization " + org
	}
	cliui.Title(os.Stderr, title)
	fmt.Fprintf(os.Stderr, "Credentials saved to %s\n", auth.CredentialsPath()) //nolint:errcheck — write to stderr is best-effort
	return 0
}

// LogoutCmd implements `dftstream logout` — removes the stored credentials.
// When DFTSTREAM_TOKEN is set, it says so: the machine token keeps
// authenticating in this shell whatever happens to credentials.json.
func LogoutCmd(args []string) int {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		cliui.Title(os.Stderr, "dftstream logout - clears stored credentials")
		return 0
	}
	if err := auth.ClearCredentials(); err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not remove credentials: %v", err), "")
		return 1
	}
	fmt.Fprintln(os.Stderr, "Logged out.") //nolint:errcheck — write to stderr is best-effort
	printLogoutMachineTokenNote(os.Stderr)
	return 0
}

// printLogoutMachineTokenNote warns that logout does not affect a machine
// token in the environment.
func printLogoutMachineTokenNote(w io.Writer) {
	if auth.MachineTokenFromEnv() == "" {
		return
	}
	fmt.Fprintf(w, "note: %s is still set in this environment and keeps authenticating commands; unset it to stop.\n", auth.EnvMachineToken) //nolint:errcheck — write to stderr is best-effort
}
