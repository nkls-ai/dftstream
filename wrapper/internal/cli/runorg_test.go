package cli

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nkls-ai/dftstream/internal/tracker"
)

// myOrgsServer answers every Convex call with the given myOrgs listing.
func myOrgsServer(t *testing.T, status int, body string) *tracker.ConvexHTTPTracker {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body)) //nolint:errcheck — test server response
	}))
	t.Cleanup(srv.Close)
	ct := tracker.NewConvexHTTPTracker(srv.URL)
	ct.SetMaxRetries(0)
	return ct
}

const labA = `{"status":"success","value":[{"organizationId":"org_1","name":"Lab A","slug":"lab-a","role":"member"}]}`

// Regression: an --org the credential cannot use surfaced only at the first
// write, the runner took it for an unreachable tracker, and ORCA ran
// untracked while the CLI still printed success.
func TestCheckRunOrgRefusesUnavailableOrg(t *testing.T) {
	err := checkRunOrg(myOrgsServer(t, http.StatusOK, labA), "lab-b")
	var st exitStatus
	if !errors.As(err, &st) || st != 2 {
		t.Fatalf("checkRunOrg(unavailable) = %v, want exit status 2", err)
	}
}

func TestCheckRunOrgAcceptsSlugIDAndEmpty(t *testing.T) {
	for _, ref := range []string{"lab-a", "org_1", ""} {
		if err := checkRunOrg(myOrgsServer(t, http.StatusOK, labA), ref); err != nil {
			t.Errorf("checkRunOrg(%q) = %v, want nil", ref, err)
		}
	}
}

// A lookup that fails in transit is not a verdict: the spool failover owns it.
func TestCheckRunOrgLeavesTransportErrorsToFailover(t *testing.T) {
	if err := checkRunOrg(myOrgsServer(t, http.StatusBadGateway, `bad gateway`), "lab-a"); err != nil {
		t.Errorf("checkRunOrg on a 502 = %v, want nil", err)
	}
}
