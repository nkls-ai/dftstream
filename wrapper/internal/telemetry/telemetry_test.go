package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The default posture is silence: no endpoint, nothing sent, ever.
func TestDisabledByDefault(t *testing.T) {
	t.Setenv(EnvEnabled, "")
	t.Setenv(EnvEndpoint, "")
	if FromEnv().Enabled() {
		t.Fatal("telemetry is enabled with no configuration")
	}
}

func TestBothOptInAndEndpointAreRequired(t *testing.T) {
	t.Setenv(EnvEnabled, "1")
	t.Setenv(EnvEndpoint, "")
	if FromEnv().Enabled() {
		t.Error("opt-in without an endpoint enabled telemetry")
	}

	t.Setenv(EnvEnabled, "")
	t.Setenv(EnvEndpoint, "https://example.invalid/t")
	if FromEnv().Enabled() {
		t.Error("an endpoint without opt-in enabled telemetry")
	}

	// Plaintext is refused rather than silently downgraded.
	t.Setenv(EnvEnabled, "1")
	t.Setenv(EnvEndpoint, "http://example.invalid/t")
	if FromEnv().Enabled() {
		t.Error("a plaintext endpoint was accepted")
	}

	t.Setenv(EnvEndpoint, "https://example.invalid/t")
	if !FromEnv().Enabled() {
		t.Error("opt-in plus an https endpoint did not enable telemetry")
	}
}

// A disabled config must not even build a request.
func TestSendIsNoOpWhenDisabled(t *testing.T) {
	if err := (Config{}).Send(context.Background(), Report{OrcaVersion: "6.0.1"}); err != nil {
		t.Fatalf("Send on a disabled config: %v", err)
	}
}

func TestSendCarriesOnlyTheAllowedFields(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	cfg := Config{Endpoint: srv.URL, Client: srv.Client()}
	if err := cfg.Send(context.Background(), Report{
		RunTypes:    []string{"OPT", "FREQ"},
		OrcaVersion: "6.0.1",
		ErrorClass:  "scf_not_converged",
		OK:          false,
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	allowed := map[string]bool{
		"runTypes": true, "orcaVersion": true, "errorClass": true, "ok": true,
		"wrapperVersion": true, "apiVersion": true, "os": true, "arch": true,
	}
	for k := range got {
		if !allowed[k] {
			t.Errorf("payload carries unexpected field %q — the field set is closed", k)
		}
	}
	if got["orcaVersion"] != "6.0.1" || got["errorClass"] != "scf_not_converged" {
		t.Errorf("payload lost the fields it is supposed to carry: %v", got)
	}
}

// The last gate before the wire: anything that looks like a path, a
// molecule or free text is dropped, whatever the caller passed.
func TestSanitizeDropsAnythingThatIsNotAPlainToken(t *testing.T) {
	in := Report{
		OrcaVersion: "/home/alice/orca/6.0.1",
		ErrorClass:  "failed while optimizing C6H6 in /scratch/alice/benzene.inp",
		RunTypes:    []string{"OPT", "../../etc/passwd", "benzene.inp", "FREQ", "* xyz 0 1"},
		OK:          true,
	}
	out := sanitize(in)
	if out.OrcaVersion != "" {
		t.Errorf("a path survived sanitization as orcaVersion: %q", out.OrcaVersion)
	}
	if out.ErrorClass != "" {
		t.Errorf("free text survived sanitization as errorClass: %q", out.ErrorClass)
	}
	want := []string{"OPT", "FREQ"}
	if len(out.RunTypes) != len(want) {
		t.Fatalf("runTypes = %v, want %v", out.RunTypes, want)
	}
	for i := range want {
		if out.RunTypes[i] != want[i] {
			t.Fatalf("runTypes = %v, want %v", out.RunTypes, want)
		}
	}
	if !out.OK {
		t.Error("sanitize dropped the ok flag")
	}
}

func TestSanitizeCapsTheRunTypeList(t *testing.T) {
	var many []string
	for i := 0; i < 50; i++ {
		many = append(many, "OPT")
	}
	if got := len(sanitize(Report{RunTypes: many}).RunTypes); got != 8 {
		t.Errorf("runTypes length = %d, want 8", got)
	}
}

func TestSendIdentifiesTheWrapperBuild(t *testing.T) {
	var ua string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ua = r.Header.Get("User-Agent")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := (Config{Endpoint: srv.URL, Client: srv.Client()}).Send(context.Background(), Report{OK: true}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !strings.HasPrefix(ua, "dftstream/") {
		t.Errorf("User-Agent = %q, want a dftstream build stamp", ua)
	}
}
