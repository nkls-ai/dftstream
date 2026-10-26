package auth

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestResolveNoCredentialsIsNone(t *testing.T) {
	isolateCredentials(t)
	t.Setenv(EnvMachineToken, "")
	t.Setenv(EnvOrg, "")

	session, err := Resolve("http://127.0.0.1:3210", "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if session.Source.Kind() != KindNone {
		t.Fatalf("kind = %v, want none", session.Source.Kind())
	}
	if tok := mustToken(t, session.Source); tok != "" {
		t.Errorf("none source sent token %q", tok)
	}
	if _, err := session.Source.Invalidate(context.Background(), ""); !errors.Is(err, ErrNoRefresh) {
		t.Errorf("none Invalidate err = %v, want ErrNoRefresh", err)
	}
	// An explicit org is still honored when unauthenticated (auth-off mode).
	session, err = Resolve("http://127.0.0.1:3210", "lab")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if session.Org != "lab" {
		t.Errorf("org = %q, want lab", session.Org)
	}
}

func TestResolveStoredLoginAndOrgPrecedence(t *testing.T) {
	isolateCredentials(t)
	t.Setenv(EnvMachineToken, "")
	if err := SaveCredentials(Credentials{
		Method:       MethodBrowserLink,
		AccessToken:  "stored-access",
		RefreshToken: "stored-refresh",
		OrgID:        "stored-org",
	}); err != nil {
		t.Fatalf("SaveCredentials: %v", err)
	}
	cases := []struct {
		name, flag, env, want string
	}{
		{"credentials default", "", "", "stored-org"},
		{"env beats credentials", "", "env-org", "env-org"},
		{"flag beats env", "flag-org", "env-org", "flag-org"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(EnvOrg, tc.env)
			session, err := Resolve("http://127.0.0.1:3210", tc.flag)
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if session.Source.Kind() != KindStoredLogin {
				t.Fatalf("kind = %v, want stored-login", session.Source.Kind())
			}
			if tok := mustToken(t, session.Source); tok != "stored-access" {
				t.Errorf("token = %q", tok)
			}
			if session.Org != tc.want {
				t.Errorf("org = %q, want %q", session.Org, tc.want)
			}
		})
	}
}

func TestResolveMachineTokenOrgPrecedence(t *testing.T) {
	isolateCredentials(t)
	srv, _, _ := fakeExchangeServer(t, http.StatusOK)
	t.Setenv(EnvMachineToken, "ost_x")
	t.Setenv(EnvOrg, "env-org")
	t.Setenv(EnvSiteURL, srv.URL) // httptest serves the site routes on its own port
	session, err := Resolve(srv.URL, "")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if session.Org != "env-org" {
		t.Errorf("org = %q, want DFTSTREAM_ORG to beat the token's org", session.Org)
	}
	if session.Source.FixHint() != MachineTokenFixHint {
		t.Errorf("machine token fix hint = %q", session.Source.FixHint())
	}
}

func TestResolveFixHintFollowsMachineToken(t *testing.T) {
	t.Setenv(EnvMachineToken, "")
	if got := ResolveFixHint(); got == MachineTokenFixHint {
		t.Errorf("hint without a machine token = %q", got)
	}
	t.Setenv(EnvMachineToken, "ost_x")
	if got := ResolveFixHint(); got != MachineTokenFixHint {
		t.Errorf("hint with a machine token = %q", got)
	}
}
