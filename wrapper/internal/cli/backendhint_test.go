package cli

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/tracker"
)

// Regression: every listing failure, including an expired or revoked
// credential, was answered with "Make sure Convex is running".
func TestBackendFixHintNamesTheCredentialFix(t *testing.T) {
	t.Setenv("DFTSTREAM_TOKEN", "")
	const fallback = "Make sure Convex is running from `db/` with `bun run dev`."
	unauthorized := fmt.Errorf("experiments:list returned HTTP 401 (%w)", tracker.ErrUnauthorized)
	if got := backendFixHint(unauthorized, fallback); strings.Contains(got, "Convex is running") || !strings.Contains(got, "dftstream login") {
		t.Errorf("401 hint = %q, want the login fix", got)
	}
	noOrg := fmt.Errorf("%w: %q", tracker.ErrOrgNotAvailable, "x")
	if got := backendFixHint(noOrg, fallback); !strings.Contains(got, "DFTSTREAM_ORG") {
		t.Errorf("org hint = %q", got)
	}
	if got := backendFixHint(fmt.Errorf("dial tcp: refused"), fallback); got != fallback {
		t.Errorf("transport hint = %q", got)
	}
}

// Regression: an un-logged-in command against an auth-on backend got a
// misleading fix. The backend answers such a call with HTTP 560 and
// "Uncaught Error: not authenticated" (not a 401); the wrapper retried it as
// a 5xx and then told the user to start Convex. Every backend command now
// prints the login / machine-token fix from the same path.
func TestBackendFixHintForUnauthenticatedCall(t *testing.T) {
	t.Setenv("DFTSTREAM_TOKEN", "")
	ct := myOrgsServer(t, 560, `{"status":"error","errorMessage":"[Request ID: 1] Server Error\nUncaught Error: not authenticated\n    at requireIdentity (../convex/authz.ts:62:18)"}`)
	_, err := ct.ListExperiments(context.Background(), "")
	if err == nil {
		t.Fatal("ListExperiments succeeded against a refusing backend")
	}
	got := backendFixHint(err, "Make sure Convex is running from `db/` with `bun run dev`.")
	if strings.Contains(got, "Convex is running") {
		t.Errorf("hint still blames the backend: %q (err: %v)", got, err)
	}
	for _, want := range []string{"dftstream login", "DFTSTREAM_TOKEN"} {
		if !strings.Contains(got, want) {
			t.Errorf("hint %q does not mention %s", got, want)
		}
	}
	if strings.Contains(err.Error(), "attempt(s)") {
		t.Errorf("a function refusal was retried as a transient 5xx: %v", err)
	}
}
