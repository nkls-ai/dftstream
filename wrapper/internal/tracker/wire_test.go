package tracker

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/levels"
)

// Typed levels must reach the Convex wire as the same strings the untyped
// code sent: experiments:ensureBatch carries artifactLevel "io", not 1.
func TestEnsureBatchSendsCanonicalArtifactLevel(t *testing.T) {
	var got convexRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		if err := json.Unmarshal(body, &got); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","value":"batch_1"}`)) //nolint:errcheck — test server response
	}))
	defer srv.Close()

	id, err := newTestTracker(srv.URL).EnsureBatch(context.Background(), "exp_1", "screen", levels.ArtifactsIO)
	if err != nil {
		t.Fatal(err)
	}
	if id != "batch_1" {
		t.Fatalf("id = %q", id)
	}
	if got.Path != fnExperimentsEnsureBatch {
		t.Fatalf("path = %q", got.Path)
	}
	want := map[string]any{"experimentId": "exp_1", "name": "screen", "artifactLevel": "io"}
	for k, v := range want {
		if got.Args[k] != v {
			t.Errorf("args[%q] = %#v, want %#v", k, got.Args[k], v)
		}
	}
}

// Non-fatal warnings go to the injected writer with the wrapper's prefix.
func TestWarningsUseInjectedWriter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","value":null}`)) //nolint:errcheck — test server response
	}))
	defer srv.Close()
	var warn bytes.Buffer
	c := newTestTracker(srv.URL)
	c.SetWarnWriter(&warn)
	states := []ExcitedState{{Idx: 1, Transitions: []OrbitalTransition{{From: "1a", To: "2a", Coeff: math.NaN()}}}}
	if err := c.SetExcitedStates(context.Background(), "run_1", states); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(warn.String(), "[dftstream] warning: excited state 1") {
		t.Fatalf("warning = %q", warn.String())
	}
}
