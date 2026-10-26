package tracker

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/nkls-ai/dftstream/internal/auth"
)

// fakeSource is a scripted auth.TokenSource.
type fakeSource struct {
	mu         sync.Mutex
	token      string
	next       string
	refreshErr error
	rejected   []string
	hint       string
}

func (f *fakeSource) Token(context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.token, nil
}

func (f *fakeSource) Invalidate(_ context.Context, rejected string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rejected = append(f.rejected, rejected)
	if f.refreshErr != nil {
		return "", f.refreshErr
	}
	f.token = f.next
	return f.token, nil
}

func (f *fakeSource) FixHint() string { return f.hint }
func (f *fakeSource) Kind() auth.Kind { return auth.KindStoredLogin }

// authServer answers 401 unless the bearer equals `valid`, recording headers.
func authServer(t *testing.T, valid string) (*httptest.Server, *[]string) {
	t.Helper()
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		mu.Lock()
		seen = append(seen, h)
		mu.Unlock()
		if h != "Bearer "+valid {
			w.WriteHeader(http.StatusUnauthorized)
			if _, err := w.Write([]byte(`{"error":"expired"}`)); err != nil {
				t.Errorf("write: %v", err)
			}
			return
		}
		if _, err := w.Write([]byte(`{"status":"success","value":null}`)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func TestTrackerRefreshesThroughTokenSourceOn401(t *testing.T) {
	srv, seen := authServer(t, "fresh")
	src := &fakeSource{token: "stale", next: "fresh"}
	ct := NewConvexHTTPTracker(srv.URL)
	ct.SetAuth(src)
	if _, err := ct.mutation(context.Background(), "x:y", map[string]any{}); err != nil {
		t.Fatalf("mutation: %v", err)
	}
	if len(src.rejected) != 1 || src.rejected[0] != "stale" {
		t.Errorf("Invalidate got %v, want [stale]", src.rejected)
	}
	if got := strings.Join(*seen, ","); got != "Bearer stale,Bearer fresh" {
		t.Errorf("headers = %s", got)
	}
}

func TestTrackerNoAuthSendsNoHeaderAndAdvisesLogin(t *testing.T) {
	srv, seen := authServer(t, "never")
	ct := NewConvexHTTPTracker(srv.URL)
	ct.SetAuth(nil)
	_, err := ct.mutation(context.Background(), "x:y", map[string]any{})
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
	if !strings.Contains(err.Error(), "Fix: run `dftstream login` to authenticate, or set DFTSTREAM_TOKEN") {
		t.Errorf("message changed: %v", err)
	}
	if strings.Contains(err.Error(), "refresh failed") {
		t.Errorf("none source must not report a refresh failure: %v", err)
	}
	if (*seen)[0] != "" {
		t.Errorf("sent Authorization %q without credentials", (*seen)[0])
	}
}

// With DFTSTREAM_TOKEN in use the 401 fix must name the machine token and
// carry why the re-exchange failed — never "run dftstream login".
func TestTracker401UsesSourceFixHintAndRefreshReason(t *testing.T) {
	srv, _ := authServer(t, "never")
	src := &fakeSource{token: "t", refreshErr: errors.New("DFTSTREAM_TOKEN has been revoked"), hint: auth.MachineTokenFixHint}
	ct := NewConvexHTTPTracker(srv.URL)
	ct.SetAuth(src)
	_, err := ct.mutation(context.Background(), "x:y", map[string]any{})
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
	msg := err.Error()
	if strings.Contains(msg, "run `dftstream login`") && !strings.Contains(msg, "unset it") {
		t.Errorf("machine-token 401 advises login: %v", err)
	}
	if !strings.Contains(msg, auth.MachineTokenFixHint) || !strings.Contains(msg, "has been revoked") {
		t.Errorf("message lacks hint or reason: %v", err)
	}
}

// Regression: an auth-on backend refuses a tokenless call inside the function
// ("not authenticated", HTTP 560 or a 200 error envelope), not with a 401.
// That was retried as a 5xx and reported as "make sure Convex is running".
func TestTrackerNotAuthenticatedRefusalIsAuthError(t *testing.T) {
	const refusal = `{"status":"error","errorMessage":"Server Error\nUncaught Error: not authenticated\n    at requireIdentity"}`
	for _, status := range []int{statusUDFFailed, http.StatusOK} {
		var calls int
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls++
			w.WriteHeader(status)
			if _, err := w.Write([]byte(refusal)); err != nil {
				t.Errorf("write: %v", err)
			}
		}))
		ct := NewConvexHTTPTracker(srv.URL)
		ct.SetAuth(nil)
		_, err := ct.query(context.Background(), "x:y", map[string]any{})
		srv.Close()
		var authErr *AuthError
		if !errors.As(err, &authErr) || !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("HTTP %d: err = %v, want AuthError", status, err)
		}
		if !strings.Contains(authErr.Fix, "dftstream login") || !strings.Contains(authErr.Fix, "DFTSTREAM_TOKEN") {
			t.Errorf("HTTP %d: fix = %q", status, authErr.Fix)
		}
		if !strings.Contains(err.Error(), "Uncaught Error: not authenticated") || strings.Contains(err.Error(), "Convex is running") {
			t.Errorf("HTTP %d: message = %v", status, err)
		}
		if calls != 1 {
			t.Errorf("HTTP %d: called %d times, a function refusal must not be retried", status, calls)
		}
	}
}

// Any other function failure on HTTP 560 is reported once, not retried.
func TestTrackerUDFFailureIsNotRetried(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(statusUDFFailed)
		if _, err := w.Write([]byte(`{"status":"error","errorMessage":"Uncaught Error: boom"}`)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	ct := NewConvexHTTPTracker(srv.URL)
	_, err := ct.query(context.Background(), "x:y", map[string]any{})
	if err == nil || errors.Is(err, ErrUnauthorized) || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v", err)
	}
	if calls != 1 {
		t.Errorf("called %d times, want 1", calls)
	}
}

// Regression: an expired browser login whose refresh was refused read
// "(refresh failed: refresh failed: HTTP 401 …)". The label is the tracker's;
// the source's own error must not repeat it, nor add a second "Fix:".
func TestTracker401RefreshFailureIsLabelledOnce(t *testing.T) {
	refresh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		if _, err := w.Write([]byte(`{"error":"invalid refresh token"}`)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(refresh.Close)
	credPath := t.TempDir() + "/credentials.json"
	t.Setenv("DFTSTREAM_CREDENTIALS", credPath)
	src := auth.NewStoredLogin(refresh.URL, credPath, auth.Credentials{
		Method: auth.MethodBrowserLink, AccessToken: "stale", RefreshToken: "r",
	})
	srv, _ := authServer(t, "never")
	ct := NewConvexHTTPTracker(srv.URL)
	ct.SetAuth(src)
	_, err := ct.mutation(context.Background(), "x:y", map[string]any{})
	if !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
	msg := err.Error()
	if n := strings.Count(msg, "refresh failed"); n != 1 {
		t.Errorf("%q appears %d times, want 1: %s", "refresh failed", n, msg)
	}
	if !strings.Contains(msg, "invalid refresh token") {
		t.Errorf("message lost the backend's reason: %s", msg)
	}
}

// A machine token's exchange error carries its own "Fix:"; the 401 message
// ends with the source's fix line, so only one may survive.
func TestTracker401CarriesOneFixClause(t *testing.T) {
	srv, _ := authServer(t, "never")
	src := &fakeSource{token: "t", refreshErr: errors.New("DFTSTREAM_TOKEN has been revoked. Fix: create a new token"), hint: auth.MachineTokenFixHint}
	ct := NewConvexHTTPTracker(srv.URL)
	ct.SetAuth(src)
	_, err := ct.mutation(context.Background(), "x:y", map[string]any{})
	msg := err.Error()
	if n := strings.Count(msg, "Fix:"); n != 1 {
		t.Errorf("%d Fix: clauses, want 1: %s", n, msg)
	}
	if strings.Contains(msg, "Fix: Fix") {
		t.Errorf("doubled fix prefix: %s", msg)
	}
}
