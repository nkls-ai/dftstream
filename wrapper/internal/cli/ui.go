// UICmd starts a small HTTP server that hosts the embedded UI bundle
// and tells the React app which Convex deployment to talk to. This
// replaces the previous `bun --hot` workflow for end users — the only
// runtime dependency is the dftstream binary itself.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/nkls-ai/dftstream/internal/buildconfig"
	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/uiserver"
	"github.com/nkls-ai/dftstream/internal/version"
)

const (
	defaultUIAddr           = "127.0.0.1:3000"
	uiConfigEnvVar          = "DFTSTREAM_CONVEX_URL"
	uiPortEnvVar            = "DFTSTREAM_UI_PORT"
	errorReportURLConfigVar = "DFTSTREAM_ERROR_REPORT_URL"
)

// uiFlags holds the raw flag values of `dftstream ui`.
type uiFlags struct {
	addr           *string
	port           *string
	convexURL      *string
	errorReportURL *string
	authProvider   *string
	clerkKey       *string
	configPath     *string
	localFiles     *bool
	noLocalFiles   *bool
}

// uiOptions is the resolved server configuration. cfgFileErr is carried
// along because a broken config file is only reported (as a warning)
// when the user explicitly pointed at one.
type uiOptions struct {
	addr           string
	convexURL      string
	errorReportURL string
	authProvider   uiAuthProvider
	clerkKey       string
	configPath     string
	localFiles     bool
	cfgFileErr     error
}

func UICmd(args []string) int {
	f, err := parseUIFlags(args)
	if err != nil {
		return exitCodeFor(err)
	}
	opts, err := resolveUIOptions(f)
	if err != nil {
		return exitCodeFor(err)
	}

	srv := &http.Server{
		Addr:              opts.addr,
		Handler:           newUIHandler(opts),
		ReadHeaderTimeout: 10 * time.Second,
	}
	printUIBanner(opts)
	return serveUI(srv)
}

func parseUIFlags(args []string) (uiFlags, error) {
	fs := flag.NewFlagSet("ui", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	f := uiFlags{
		addr:           fs.String("addr", "", "HTTP listen address (default: env DFTSTREAM_UI_ADDR or "+defaultUIAddr+")"),
		port:           fs.String("port", "", "HTTP port to listen on (default: env DFTSTREAM_UI_PORT or port from --addr/config)"),
		convexURL:      fs.String("convex-url", "", "Convex deployment URL the UI should connect to (default: env DFTSTREAM_CONVEX_URL or config file)"),
		errorReportURL: fs.String("error-report-url", "", "HTTP endpoint for browser error reports (default: env DFTSTREAM_ERROR_REPORT_URL or config file)"),
		authProvider:   fs.String("auth-provider", "", "auth provider to mount in the UI: convex|clerk (default: env DFTSTREAM_AUTH_PROVIDER; empty = no auth)"),
		clerkKey:       fs.String("clerk-publishable-key", "", "Clerk publishable key (clerk provider only; default: env DFTSTREAM_CLERK_PUBLISHABLE_KEY)"),
		configPath:     fs.String("config", "", "path to JSON config file (default: env DFTSTREAM_UI_CONFIG or ~/.config/dftstream/config.json)"),
		localFiles:     fs.Bool("local-files", false, "enable the /api/local-file endpoint even when an auth provider is configured (also env DFTSTREAM_UI_LOCAL_FILES=1)"),
		noLocalFiles:   fs.Bool("no-local-files", false, "disable the /api/local-file endpoint (Tools tab path loading; also env DFTSTREAM_UI_LOCAL_FILES=0)"),
	}

	fs.Usage = func() {
		cliui.Title(os.Stderr, "dftstream ui - serve the embedded web UI")
		fmt.Fprintln(os.Stderr, `
Usage:
  dftstream ui [flags]

Flags:`)
		fs.PrintDefaults()
		fmt.Fprintln(os.Stderr, `
Examples:
  # Local: Convex on the same machine
  dftstream ui

  # Use a different local port
  dftstream ui --port 3001

  # Online: point at a hosted Convex deployment
  dftstream ui --convex-url=https://your-deployment.convex.cloud

  # Persist the URL so future runs don't need the flag
  mkdir -p ~/.config/dftstream
  printf '{"convexUrl":"https://your-deployment.convex.cloud"}' > ~/.config/dftstream/config.json
  dftstream ui`)
	}

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return uiFlags{}, exitStatus(0)
		}
		return uiFlags{}, exitStatus(2)
	}
	return f, nil
}

// resolveUIOptions layers flags over environment variables, the config
// file, and built-in defaults.
func resolveUIOptions(f uiFlags) (uiOptions, error) {
	cfgFile, cfgFileErr := loadConfigFile(*f.configPath)

	resolvedAddr := resolve(*f.addr, "DFTSTREAM_UI_ADDR", "")
	if resolvedAddr == "" {
		resolvedAddr = cfgFile.Addr
	}
	if resolvedAddr == "" {
		resolvedAddr = defaultUIAddr
	}
	if p := resolve(*f.port, uiPortEnvVar, ""); p != "" {
		nextAddr, err := withPort(resolvedAddr, p)
		if err != nil {
			cliui.Error(os.Stderr, err.Error(), "Use a numeric port from 1 to 65535, for example `dftstream ui --port 3001`.")
			return uiOptions{}, exitStatus(2)
		}
		resolvedAddr = nextAddr
	}

	resolvedURL := resolve(*f.convexURL, uiConfigEnvVar, "")
	if resolvedURL == "" {
		resolvedURL = cfgFile.ConvexURL
	}
	if resolvedURL == "" {
		// Last-ditch: derive from DFTSTREAM_TRACKER_URL the wrapper
		// already uses (strip the `convex+` scheme prefix). This keeps
		// `dftstream run` and `dftstream ui` pointing at the same
		// backend by default.
		if tu := os.Getenv("DFTSTREAM_TRACKER_URL"); tu != "" {
			resolvedURL = strings.TrimPrefix(tu, "convex+")
		}
	}
	if resolvedURL == "" {
		resolvedURL = buildconfig.DefaultConvexURL
	}

	resolvedErrorReportURL := resolve(*f.errorReportURL, errorReportURLConfigVar, "")
	if resolvedErrorReportURL == "" {
		resolvedErrorReportURL = cfgFile.ErrorReportURL
	}

	// Auth is enabled in the UI as soon as a provider is configured. An
	// unknown provider, or Clerk without its key, fails here rather than in
	// every user's browser.
	clerkKey := resolve(*f.clerkKey, "DFTSTREAM_CLERK_PUBLISHABLE_KEY", "")
	authProvider, err := parseUIAuthProvider(resolve(*f.authProvider, "DFTSTREAM_AUTH_PROVIDER", ""), clerkKey)
	if err != nil {
		cliui.Error(os.Stderr, err.Error(), "See docs/auth.md for provider setup.")
		return uiOptions{}, exitStatus(2)
	}

	return uiOptions{
		addr:           resolvedAddr,
		convexURL:      resolvedURL,
		errorReportURL: resolvedErrorReportURL,
		authProvider:   authProvider,
		clerkKey:       clerkKey,
		configPath:     *f.configPath,
		localFiles:     resolveLocalFiles(*f.localFiles, *f.noLocalFiles, os.Getenv("DFTSTREAM_UI_LOCAL_FILES"), authProvider),
		cfgFileErr:     cfgFileErr,
	}, nil
}

// resolveLocalFiles decides whether /api/local-file is mounted.
//
// The endpoint reads files off this host with no authentication of its
// own, so the moment an auth provider is configured — a deployment that
// evidently has more than one user in mind — it defaults OFF and must be
// re-enabled explicitly (--local-files or DFTSTREAM_UI_LOCAL_FILES=1).
// Without a provider it stays on by default, as before. An explicit
// disable (flag or env) always wins.
func resolveLocalFiles(flagOn, flagOff bool, env string, authProvider uiAuthProvider) bool {
	explicitOn := flagOn || env == "1" || strings.EqualFold(env, "true")
	explicitOff := flagOff || env == "0" || strings.EqualFold(env, "false")
	if explicitOff {
		return false
	}
	if authProvider.enabled() {
		return explicitOn
	}
	return true
}

// isLoopbackHost reports whether the host part of a listen address can
// only be reached from this machine.
func isLoopbackHost(addr string) bool {
	host := addr
	if h, _, err := net.SplitHostPort(addr); err == nil {
		host = h
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func newUIHandler(opts uiOptions) http.Handler {
	return uiserver.Handler(uiserver.Config{
		ConvexURL:           opts.convexURL,
		Version:             version.Version,
		ErrorReportURL:      opts.errorReportURL,
		AuthRequired:        opts.authProvider.enabled(),
		AuthProvider:        string(opts.authProvider),
		ClerkPublishableKey: opts.clerkKey,
		LocalFileEnabled:    opts.localFiles,
		AllowedHost:         opts.addr,
	})
}

func printUIBanner(opts uiOptions) {
	cliui.Title(os.Stderr, "dftstream ui")
	if opts.cfgFileErr != nil {
		// Non-fatal — config file is optional. Show only when the user
		// explicitly pointed at a path that didn't exist.
		if opts.configPath != "" || os.Getenv("DFTSTREAM_UI_CONFIG") != "" {
			cliui.Warning(os.Stderr, fmt.Sprintf("could not load UI config: %v", opts.cfgFileErr), "Continuing with flags and environment values.")
		}
	}
	fmt.Fprintf(os.Stderr, "listening on http://%s\n", opts.addr)
	fmt.Fprintf(os.Stderr, "convex url:  %s\n", opts.convexURL)
	if opts.errorReportURL != "" {
		fmt.Fprintf(os.Stderr, "error reports: %s\n", opts.errorReportURL)
	}
	if opts.authProvider.enabled() && !opts.localFiles {
		fmt.Fprintf(os.Stderr, "local files: /api/local-file disabled (auth provider configured; pass --local-files to enable)\n")
	}
	if opts.localFiles && !isLoopbackHost(opts.addr) {
		cliui.Warning(os.Stderr, fmt.Sprintf("/api/local-file is enabled on non-loopback address %s: anyone who can reach this port can read .xyz/.trj/.allxyz/.interp/.out files on this host", opts.addr), "Pass --no-local-files to disable it.")
	}
}

// serveUI runs the server until it fails or a SIGINT/SIGTERM asks for a
// graceful shutdown.
func serveUI(srv *http.Server) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		err := srv.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
			return
		}
		errCh <- nil
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			cliui.Warning(os.Stderr, fmt.Sprintf("graceful shutdown failed: %v", err), "")
		}
		return 0
	case err := <-errCh:
		if err != nil {
			cliui.Error(os.Stderr, fmt.Sprintf("UI server failed: %v", err), "Check that the listen address is not in use.")
			return 1
		}
		return 0
	}
}

func withPort(addr string, port string) (string, error) {
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return "", fmt.Errorf("invalid UI port %q", port)
	}

	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		if strings.Count(addr, ":") == 0 {
			host = addr
		} else {
			return "", fmt.Errorf("invalid UI listen address %q", addr)
		}
	}
	return net.JoinHostPort(host, strconv.Itoa(p)), nil
}
