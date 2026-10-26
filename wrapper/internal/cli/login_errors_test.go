package cli

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// captureStderr runs fn with os.Stderr redirected and returns what it wrote.
func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	old := os.Stderr
	os.Stderr = w
	done := make(chan string)
	go func() {
		b, rerr := io.ReadAll(r)
		if rerr != nil {
			t.Errorf("read captured stderr: %v", rerr)
		}
		done <- string(b)
	}()
	fn()
	os.Stderr = old
	if err := w.Close(); err != nil {
		t.Fatalf("close pipe: %v", err)
	}
	out := <-done
	if err := r.Close(); err != nil {
		t.Fatalf("close pipe reader: %v", err)
	}
	return out
}

func statusServer(t *testing.T, status int, body string) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if _, err := w.Write([]byte(body)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

// A backend that cannot sign tokens used to be polled for five minutes and
// reported as "timed out waiting for approval". Its own 503 is terminal.
func TestAwaitLinkApprovalBackend503IsTerminalAndNamed(t *testing.T) {
	srv, calls := statusServer(t, http.StatusServiceUnavailable, `{"error":"CLI token signing is not configured on this deployment"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var err error
	out := captureStderr(t, func() {
		_, err = awaitLinkApproval(ctx, srv.URL, linkStart{DeviceCode: "d", Interval: 1})
	})
	if err == nil {
		t.Fatal("expected a terminal error")
	}
	if calls.Load() != 1 {
		t.Errorf("polled %d times, want 1", calls.Load())
	}
	if !strings.Contains(out, "signing is not configured") {
		t.Errorf("stderr does not carry the backend's reason:\n%s", out)
	}
}

func TestAwaitLinkApprovalConflictIsTerminal(t *testing.T) {
	srv, calls := statusServer(t, http.StatusConflict, `{"error":"link not bound"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var err error
	captureStderr(t, func() {
		_, err = awaitLinkApproval(ctx, srv.URL, linkStart{DeviceCode: "d", Interval: 1})
	})
	if err == nil || calls.Load() != 1 {
		t.Fatalf("err=%v calls=%d, want terminal after one poll", err, calls.Load())
	}
}

// A proxy 5xx stays transient, but the timeout names it instead of claiming
// the user never approved.
func TestAwaitLinkApprovalTimeoutNamesLastError(t *testing.T) {
	srv, calls := statusServer(t, http.StatusBadGateway, `<html>bad gateway</html>`)
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	out := captureStderr(t, func() {
		if _, err := awaitLinkApproval(ctx, srv.URL, linkStart{DeviceCode: "d", Interval: 1}); err == nil {
			t.Error("expected a timeout")
		}
	})
	if calls.Load() < 2 {
		t.Errorf("a proxy 502 should be retried, polled %d times", calls.Load())
	}
	if !strings.Contains(out, "HTTP 502") {
		t.Errorf("timeout message omits the last error:\n%s", out)
	}
}

func TestPersistLoginCredentialsPrintsRealPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "custom-creds.json")
	t.Setenv("DFTSTREAM_CREDENTIALS", path)
	var code int
	out := captureStderr(t, func() {
		code = persistLoginCredentials(linkApproval{AccessToken: "a", RefreshToken: "r", OrganizationID: "o"})
	})
	if code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if !strings.Contains(out, path) {
		t.Errorf("output does not name %s:\n%s", path, out)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o, want 600", info.Mode().Perm())
	}
}

// Regression: login printed a bare "logged in" while the browser approval
// page named the org; the terminal now says which org the CLI acts in.
func TestPersistLoginCredentialsNamesOrg(t *testing.T) {
	t.Setenv("DFTSTREAM_CREDENTIALS", filepath.Join(t.TempDir(), "creds.json"))
	var code int
	out := captureStderr(t, func() {
		code = persistLoginCredentials(linkApproval{
			AccessToken: "a", RefreshToken: "r", OrganizationID: "org_1",
			OrganizationName: "Lab A", OrganizationSlug: "lab-a",
		})
	})
	if code != 0 {
		t.Fatalf("exit code %d:\n%s", code, out)
	}
	if !strings.Contains(out, "logged in to organization Lab A (lab-a)") {
		t.Errorf("login output does not name the org:\n%s", out)
	}
}

func TestLinkApprovalOrgLabelFallsBack(t *testing.T) {
	cases := []struct {
		a    linkApproval
		want string
	}{
		{linkApproval{OrganizationID: "org_1", OrganizationSlug: "lab-a"}, "lab-a"},
		{linkApproval{OrganizationID: "org_1", OrganizationName: "Lab A"}, "Lab A"},
		{linkApproval{OrganizationID: "org_1", OrganizationName: "lab", OrganizationSlug: "lab"}, "lab"},
		// An older backend sends only the id.
		{linkApproval{OrganizationID: "org_1"}, "org_1"},
	}
	for _, c := range cases {
		if got := c.a.orgLabel(); got != c.want {
			t.Errorf("orgLabel(%+v) = %q, want %q", c.a, got, c.want)
		}
	}
}

func TestLogoutNotesActiveMachineToken(t *testing.T) {
	var b strings.Builder
	t.Setenv("DFTSTREAM_TOKEN", "")
	printLogoutMachineTokenNote(&b)
	if b.Len() != 0 {
		t.Errorf("note printed without a machine token: %q", b.String())
	}
	t.Setenv("DFTSTREAM_TOKEN", "ost_x")
	printLogoutMachineTokenNote(&b)
	if !strings.Contains(b.String(), "DFTSTREAM_TOKEN is still set") {
		t.Errorf("no machine-token note: %q", b.String())
	}
	if strings.Contains(b.String(), "ost_x") {
		t.Error("note leaks the token")
	}
}
