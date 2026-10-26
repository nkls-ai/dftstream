package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"

	"github.com/nkls-ai/dftstream/internal/auth"
	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// backendFlags are the -tracker-url / -org flags shared by every command
// that talks to the tracking backend. Names, defaults and help text are
// identical everywhere.
type backendFlags struct {
	trackerURL string
	org        string
}

// register adds -tracker-url and -org to fs.
func (b *backendFlags) register(fs *flag.FlagSet) {
	b.registerTrackerURL(fs)
	fs.StringVar(&b.org, "org", "", "organization slug/id (default: env DFTSTREAM_ORG or the logged-in default)")
}

// registerTrackerURL adds only -tracker-url, for commands that have no
// organization context (login, import-cubes).
func (b *backendFlags) registerTrackerURL(fs *flag.FlagSet) {
	fs.StringVar(&b.trackerURL, "tracker-url", "",
		"backend DSN (default: env DFTSTREAM_TRACKER_URL, the config file, or "+defaultTrackerURL+")")
}

// dsn resolves the backend DSN: flag, then env, then config file, then the
// build default.
func (b backendFlags) dsn() string { return resolveTrackerURL(b.trackerURL) }

// handshakePolicy says whether a command runs the wrapper↔backend version
// handshake after opening the backend.
type handshakePolicy int

const (
	// handshakeSkip opens without asking the backend for its version.
	handshakeSkip handshakePolicy = iota
	// handshakeRequired runs checkBackendVersion: a definitive mismatch is
	// fatal, an unanswerable handshake only warns.
	handshakeRequired
)

// backendSpec tunes openConvexBackend for one command.
type backendSpec struct {
	dsn string
	org string
	// openHint is shown when dsn is not a Convex backend.
	openHint string
	// maxRetries shortens the tracker's retry ladder; 0 keeps the default.
	maxRetries int
	handshake  handshakePolicy
	// quiet returns credential/open failures unprinted, for best-effort
	// callers that report them in their own words.
	quiet bool
}

// errNotConvexBackend marks a DSN that is valid but not a Convex backend
// (noop://), or not a DSN at all.
var errNotConvexBackend = errors.New("not a Convex backend")

// openConvexBackend is the one path by which a command reaches the raw
// Convex tracker: resolve credentials, open, shorten retries, handshake.
// It returns the target organization and the tracker. Unless spec.quiet,
// every failure is printed and returned as exitStatus(2) (or the
// handshake's own exit status).
func openConvexBackend(spec backendSpec) (string, *tracker.ConvexHTTPTracker, error) {
	var (
		orgID string
		src   auth.TokenSource
		err   error
	)
	if spec.quiet {
		if orgID, src, err = resolveAuth(spec.dsn, spec.org); err != nil {
			return "", nil, err
		}
	} else if orgID, src, err = resolveBackendAuth(spec.dsn, spec.org); err != nil {
		return "", nil, err
	}
	ct, err := tracker.OpenConvex(spec.dsn, src)
	if err != nil {
		if spec.quiet {
			return "", nil, fmt.Errorf("%w: %w", errNotConvexBackend, err)
		}
		cliui.Error(os.Stderr, fmt.Sprintf("could not open tracker: %v", err), spec.openHint)
		return "", nil, exitStatus(2)
	}
	if spec.maxRetries > 0 {
		ct.SetMaxRetries(spec.maxRetries)
	}
	if spec.handshake == handshakeRequired {
		if err := handshakeOrClose(ct, spec.dsn); err != nil {
			return "", nil, err
		}
	}
	return orgID, ct, nil
}

// resolveBackendAuth resolves stored credentials for dsn, printing the
// failure with the standard fix hint.
func resolveBackendAuth(dsn, org string) (string, auth.TokenSource, error) {
	orgID, src, err := resolveAuth(dsn, org)
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not resolve credentials: %v", err), authFixHint())
		return "", nil, exitStatus(2)
	}
	return orgID, src, nil
}

// handshakeOrClose runs the version handshake and, on a definitive
// mismatch, closes the tracker before returning the handshake's error.
func handshakeOrClose(tr tracker.Tracker, dsn string) error {
	err := checkBackendVersion(context.Background(), tr, dsn, os.Stderr)
	if err == nil {
		return nil
	}
	if cerr := tr.Close(context.Background()); cerr != nil {
		// Nothing was written yet, so a failed close costs no data; still
		// say so rather than discarding the error silently.
		fmt.Fprintf(os.Stderr, "[dftstream] note: closing tracker after version check: %v\n", cerr) //nolint:errcheck — write to stderr is best-effort
	}
	return err
}
