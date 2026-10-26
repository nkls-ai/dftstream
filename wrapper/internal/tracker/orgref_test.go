package tracker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// orgServer answers organizations:myOrgs with `orgs` and experiments:ensure
// with "exp_1", recording every request.
func orgServer(t *testing.T, orgs string) (*httptest.Server, func() []convexRequest) {
	t.Helper()
	var mu sync.Mutex
	var seen []convexRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		var req convexRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Errorf("decode body: %v", err)
		}
		mu.Lock()
		seen = append(seen, req)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		value := `"exp_1"`
		if req.Path == fnOrganizationsMyOrgs {
			value = orgs
		}
		_, _ = w.Write([]byte(`{"status":"success","value":` + value + `}`)) //nolint:errcheck — test server response
	}))
	t.Cleanup(srv.Close)
	return srv, func() []convexRequest {
		mu.Lock()
		defer mu.Unlock()
		return append([]convexRequest(nil), seen...)
	}
}

// Regression: `--org <slug>` went to the backend verbatim, failed the
// v.id("organizations") validator, and the run fell back to untracked.
func TestEnsureExperimentResolvesOrgSlugToID(t *testing.T) {
	srv, seen := orgServer(t, `[{"organizationId":"org_123","name":"Lab A","slug":"lab-a","role":"member"}]`)
	tr := newTestTracker(srv.URL)
	for i := 0; i < 2; i++ {
		if _, err := tr.EnsureExperiment(context.Background(), "lab-a", "exp"); err != nil {
			t.Fatal(err)
		}
	}
	reqs := seen()
	lookups := 0
	for _, r := range reqs {
		switch r.Path {
		case fnOrganizationsMyOrgs:
			lookups++
		case fnExperimentsEnsure:
			if got := r.Args["organizationId"]; got != "org_123" {
				t.Errorf("ensure sent organizationId %v, want the resolved id org_123", got)
			}
		}
	}
	if lookups != 1 {
		t.Errorf("myOrgs queried %d times, want once (cached)", lookups)
	}
}

func TestMatchOrgRef(t *testing.T) {
	orgs := []orgListing{{OrganizationID: "org_1", Slug: "lab-a"}, {OrganizationID: "org_2", Slug: "lab-b"}}
	for ref, want := range map[string]string{"lab-a": "org_1", "LAB-B": "org_2", "org_2": "org_2"} {
		got, err := matchOrgRef(ref, orgs)
		if err != nil || got != want {
			t.Errorf("matchOrgRef(%q) = %q, %v; want %q", ref, got, err, want)
		}
	}
	_, err := matchOrgRef("lab-z", orgs)
	if !errors.Is(err, ErrOrgNotAvailable) || !strings.Contains(err.Error(), "lab-a, lab-b") {
		t.Errorf("unknown ref should be ErrOrgNotAvailable naming the usable orgs, got %v", err)
	}
	// No orgs visible (auth off / not logged in): pass through, backend decides.
	if got, err := matchOrgRef("anything", nil); err != nil || got != "anything" {
		t.Errorf("no-org passthrough = %q, %v", got, err)
	}
}

func TestEnsureExperimentWithoutOrgSkipsLookup(t *testing.T) {
	srv, seen := orgServer(t, `[]`)
	if _, err := newTestTracker(srv.URL).EnsureExperiment(context.Background(), "", "exp"); err != nil {
		t.Fatal(err)
	}
	for _, r := range seen() {
		if r.Path == fnOrganizationsMyOrgs {
			t.Error("no org given, yet myOrgs was queried")
		}
	}
}
