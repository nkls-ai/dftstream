package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeExchangeServer serves POST /cli/token/exchange, answering per `status`
// and recording every presented token. status 200 responds with accessToken
// "minted-<n>" (n = call count) and organizationId "org-from-token".
func fakeExchangeServer(t *testing.T, status int) (*httptest.Server, *atomic.Int64, *atomic.Value) {
	t.Helper()
	var calls atomic.Int64
	var lastToken atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cli/token/exchange" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		var body struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode exchange body: %v", err)
		}
		lastToken.Store(body.Token)
		n := calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if status != http.StatusOK {
			w.WriteHeader(status)
			if err := json.NewEncoder(w).Encode(map[string]string{"error": "nope"}); err != nil {
				t.Errorf("write error body: %v", err)
			}
			return
		}
		if err := json.NewEncoder(w).Encode(map[string]any{
			"accessToken":    "minted-" + string(rune('0'+n)),
			"organizationId": "org-from-token",
		}); err != nil {
			t.Errorf("write exchange response: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &calls, &lastToken
}

// isolateCredentials points the credentials file into an empty temp dir and
// returns its path, so tests can assert nothing is ever written there.
func isolateCredentials(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv("DFTSTREAM_CREDENTIALS", path)
	return path
}

func TestResolveAuthUsesMachineTokenFromEnv(t *testing.T) {
	credPath := isolateCredentials(t)
	srv, calls, lastToken := fakeExchangeServer(t, http.StatusOK)
	t.Setenv("DFTSTREAM_TOKEN", "ost_test-secret")
	t.Setenv("DFTSTREAM_ORG", "")

	t.Setenv(EnvSiteURL, srv.URL) // httptest serves the site routes on its own port
	session, err := Resolve(srv.URL, "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	org := session.Org
	if session.Source.Kind() != KindMachineToken {
		t.Fatalf("source kind = %v, want machine-token", session.Source.Kind())
	}
	first := mustToken(t, session.Source)
	if first != "minted-1" {
		t.Errorf("access token = %q, want the exchanged one", first)
	}
	if org != "org-from-token" {
		t.Errorf("org = %q, want the token's bound org", org)
	}
	if got := lastToken.Load(); got != "ost_test-secret" {
		t.Errorf("server saw token %q", got)
	}

	// The refresher re-exchanges the same env token; no refresh chain.
	tok, err := session.Source.Invalidate(context.Background(), first)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if tok != "minted-2" || calls.Load() != 2 {
		t.Errorf("refresh minted %q after %d calls, want a second exchange", tok, calls.Load())
	}

	// The no-disk-write guarantee: neither startup exchange nor refresh may
	// leave any credential on disk.
	if _, err := os.Stat(credPath); !os.IsNotExist(err) {
		t.Errorf("credentials file exists after machine-token auth (stat err=%v)", err)
	}
}

func TestMachineTokenTakesPrecedenceOverStoredCredentials(t *testing.T) {
	isolateCredentials(t)
	if err := SaveCredentials(Credentials{
		Method:       MethodBrowserLink,
		AccessToken:  "stored-access",
		RefreshToken: "stored-refresh",
		OrgID:        "stored-org",
	}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	srv, _, _ := fakeExchangeServer(t, http.StatusOK)
	t.Setenv("DFTSTREAM_TOKEN", "ost_batch")
	t.Setenv("DFTSTREAM_ORG", "")

	t.Setenv(EnvSiteURL, srv.URL) // httptest serves the site routes on its own port
	session, err := Resolve(srv.URL, "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	org := session.Org
	if mustToken(t, session.Source) == "stored-access" {
		t.Error("stored credentials shadowed DFTSTREAM_TOKEN")
	}
	if org == "stored-org" {
		t.Error("stored org shadowed the machine token's org")
	}

	// And --org still wins over the token's default org.
	session, err = Resolve(srv.URL, "explicit-org")
	if err != nil {
		t.Fatalf("Resolve with --org: %v", err)
	}
	if session.Org != "explicit-org" {
		t.Errorf("org = %q, want the explicit --org value", org)
	}
}

func TestMachineTokenRevokedAndInvalidAreTerminalAndActionable(t *testing.T) {
	isolateCredentials(t)
	t.Setenv("DFTSTREAM_ORG", "")
	cases := map[string]struct {
		status int
		want   string
	}{
		"revoked": {http.StatusGone, "revoked"},
		"invalid": {http.StatusUnauthorized, "rejected as invalid"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			srv, calls, _ := fakeExchangeServer(t, tc.status)
			t.Setenv("DFTSTREAM_TOKEN", "ost_dead-secret")
			t.Setenv(EnvSiteURL, srv.URL) // httptest serves the site routes on its own port
			_, err := Resolve(srv.URL, "")
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not name the cause %q", err, tc.want)
			}
			// The fix must be spelled out…
			if !strings.Contains(err.Error(), "Settings → Machine tokens") {
				t.Errorf("error %q does not name the fix", err)
			}
			// …and the secret itself must never leak into the message.
			if strings.Contains(err.Error(), "ost_dead-secret") {
				t.Errorf("error leaks the machine token: %q", err)
			}
			// Terminal: no retry ladder against a deliberate rejection.
			if calls.Load() != 1 {
				t.Errorf("made %d exchange calls, want exactly 1", calls.Load())
			}
		})
	}
}

func TestMachineTokenExchangeRetriesThrottle(t *testing.T) {
	isolateCredentials(t)
	// First call answers 429 slow_down (parallel array tasks share a token),
	// the second succeeds — the wrapper must ride it out.
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			if _, err := w.Write([]byte(`{"error":"slow_down"}`)); err != nil {
				t.Errorf("write throttle response: %v", err)
			}
			return
		}
		if _, err := w.Write([]byte(`{"accessToken":"minted","organizationId":"org1"}`)); err != nil {
			t.Errorf("write exchange response: %v", err)
		}
	}))
	defer srv.Close()

	access, org, err := exchangeMachineToken(context.Background(), srv.URL, "ost_shared")
	if err != nil {
		t.Fatalf("exchangeMachineToken: %v", err)
	}
	if access != "minted" || org != "org1" {
		t.Errorf("got (%q,%q), want the post-throttle exchange", access, org)
	}
	if calls.Load() != 2 {
		t.Errorf("made %d calls, want 2 (one throttled, one served)", calls.Load())
	}
}

func TestMachineTokenBackendWithoutSupportIsExplained(t *testing.T) {
	isolateCredentials(t)
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	_, _, err := exchangeMachineToken(context.Background(), srv.URL, "ost_x")
	if err == nil {
		t.Fatal("expected an error for a 404 backend")
	}
	if !strings.Contains(err.Error(), "does not support machine tokens") {
		t.Errorf("error %q does not explain the missing backend support", err)
	}
}

// mustToken reads a source's current token, failing the test on error.
func mustToken(t *testing.T, src TokenSource) string {
	t.Helper()
	tok, err := src.Token(context.Background())
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	return tok
}
