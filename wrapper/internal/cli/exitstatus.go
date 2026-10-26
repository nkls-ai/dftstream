package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/tracker"
	"github.com/nkls-ai/dftstream/internal/version"
)

// exitStatus carries a process exit code through the parse/validate/
// execute steps of a command. The failing step prints its own
// user-facing message before returning one; the error only transports
// the code. Code 0 is used by --help paths, which stop a command
// without failure.
type exitStatus int

func (e exitStatus) Error() string { return fmt.Sprintf("exit status %d", int(e)) }

// exitCodeFor maps a step error back to the command's process exit code.
func exitCodeFor(err error) int {
	var e exitStatus
	if errors.As(err, &e) {
		return int(e)
	}
	return 1
}

// openAuthedTracker resolves stored credentials for dsn and opens the
// batching tracker for any supported DSN (noop:// included), returning the
// target organization alongside it. openHint is the command's guidance
// when the DSN cannot be opened. Commands that need the raw Convex client
// use openConvexBackend instead.
func openAuthedTracker(dsn, orgFlag, openHint string) (string, tracker.Tracker, error) {
	orgID, src, err := resolveBackendAuth(dsn, orgFlag)
	if err != nil {
		return "", nil, err
	}
	tr, err := tracker.OpenWithAuth(dsn, src)
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not open tracker: %v", err), openHint)
		return "", nil, exitStatus(2)
	}
	if err := handshakeOrClose(tr, dsn); err != nil {
		return "", nil, exitStatus(2)
	}
	return orgID, tr, nil
}

// checkBackendVersion is the wrapper↔backend compatibility handshake, run
// once per network-touching subcommand (every one of them funnels through
// openAuthedTracker). It has exactly three outcomes:
//
//   - compatible → nothing printed, nil returned;
//   - handshake impossible (noop://, backend older than meta:version,
//     backend unreachable, token stale) → ONE warning line, nil returned.
//     Tracking must never be lost over an unanswered handshake;
//   - definitive mismatch → one error line naming the exact fix command
//     and a non-nil error, because every subsequent backend call would
//     fail anyway and a wall of Convex 400s is not a diagnosis.
//
// Support policy: a backend at API version N serves wrappers at N and
// N-1 (it reports the floor itself as minWrapperApiVersion).
func checkBackendVersion(ctx context.Context, tr tracker.Tracker, dsn string, w io.Writer) error {
	vr, ok := tr.(tracker.VersionReporter)
	if !ok {
		return nil // tracker kind that never talks to a deployment
	}
	bv, err := vr.BackendVersion(ctx)
	if err != nil {
		if errors.Is(err, tracker.ErrVersionUnsupported) {
			// Degrade, never fail: a pre-handshake backend (or a blip) must
			// not cost the chemist their run's tracking.
			cliui.Warning(w, fmt.Sprintf("could not verify backend version (%v) — continuing", err), "")
			return nil
		}
		cliui.Warning(w, fmt.Sprintf("backend version check failed (%v) — continuing", err), "")
		return nil
	}
	switch {
	case version.APIVersion > bv.APIVersion:
		cliui.Error(w, fmt.Sprintf(
			"backend is older than this wrapper (backend API v%d, wrapper API v%d) — its functions do not accept this binary's calls",
			bv.APIVersion, version.APIVersion),
			pushFunctionsCommand(dsn))
		return exitStatus(2)
	case version.APIVersion < bv.MinWrapperAPIVersion:
		cliui.Error(w, fmt.Sprintf(
			"this wrapper is too old for the backend (wrapper API v%d, backend serves v%d and newer)",
			version.APIVersion, bv.MinWrapperAPIVersion),
			"curl -fsSL https://raw.githubusercontent.com/nkls-ai/dftstream/main/scripts/install.sh | bash")
		return exitStatus(2)
	}
	return nil
}

// pushFunctionsCommand names the exact command that redeploys the Convex
// functions to the deployment the caller is actually pointed at, so the
// fix can be copy-pasted rather than reconstructed from the docs.
func pushFunctionsCommand(dsn string) string {
	httpURL := strings.TrimPrefix(dsn, "convex+")
	if httpURL == dsn || httpURL == "" {
		// Not a convex+ DSN (or empty): fall back to the cloud form, which
		// needs no URL.
		return "cd db && bunx convex deploy"
	}
	return "bash db/docker/push-functions.sh " + httpURL
}
