package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// rotatingServer mimics /cli/link/refresh: every redemption of the current
// token rotates it; the superseded token is honored (access only, no
// rotation) within `grace`; presenting it after that revokes the session.
type rotatingServer struct {
	mu        sync.Mutex
	current   string
	prev      string
	rotatedAt time.Time
	grace     time.Duration
	revoked   bool
	calls     int
	n         int
	// graceOnly makes every redemption answer on the grace path (access
	// token, no rotation), as when another host already rotated.
	graceOnly bool
}

func (s *rotatingServer) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			RefreshToken string `json:"refreshToken"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		// Hold the request a moment so concurrent refreshers overlap.
		time.Sleep(20 * time.Millisecond)
		s.mu.Lock()
		defer s.mu.Unlock()
		s.calls++
		s.n++
		access := fmt.Sprintf("access-%d", s.n)
		reply := func(v any) {
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(v); err != nil {
				t.Errorf("encode: %v", err)
			}
		}
		switch {
		case s.revoked:
			w.WriteHeader(http.StatusUnauthorized)
			reply(map[string]string{"error": "invalid refresh token"})
		case body.RefreshToken == s.current && !s.graceOnly:
			s.prev, s.current, s.rotatedAt = s.current, fmt.Sprintf("refresh-%d", s.n), time.Now()
			reply(map[string]string{"accessToken": access, "refreshToken": s.current})
		case body.RefreshToken == s.current && s.graceOnly:
			reply(map[string]string{"accessToken": access})
		case body.RefreshToken == s.prev && time.Since(s.rotatedAt) <= s.grace:
			reply(map[string]string{"accessToken": access})
		default:
			// Replay of a rotated-out token: the session is presumed stolen.
			s.revoked = true
			w.WriteHeader(http.StatusUnauthorized)
			reply(map[string]string{"error": "invalid refresh token"})
		}
	}
}

func startRotating(t *testing.T, rs *rotatingServer) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(rs.handler(t))
	t.Cleanup(srv.Close)
	return srv
}

func seedLogin(t *testing.T) (string, Credentials) {
	t.Helper()
	path := isolateCredentials(t)
	c := Credentials{Method: MethodBrowserLink, AccessToken: "access-0", RefreshToken: "refresh-0", OrgID: "org"}
	if err := SaveCredentials(c); err != nil {
		t.Fatalf("SaveCredentials: %v", err)
	}
	return path, c
}

func quiet(s *StoredLogin) *StoredLogin {
	s.warn = io.Discard
	return s
}

// Two processes sharing credentials.json both get a 401 for the same access
// token. Without cross-process serialization, the loser presents the
// superseded refresh token (grace path) and can write it back over the
// winner's rotation, so the NEXT refresh — after the grace window — is
// treated as theft and revokes the whole session.
func TestStoredLoginConcurrentProcessesKeepSessionAlive(t *testing.T) {
	path, c := seedLogin(t)
	rs := &rotatingServer{current: "refresh-0", grace: time.Hour}
	srv := startRotating(t, rs)

	// Separate instances = separate processes (separate mutexes; flock locks
	// are per open file description, so they still exclude each other).
	a := quiet(NewStoredLogin(srv.URL, path, c))
	b := quiet(NewStoredLogin(srv.URL, path, c))
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, s := range []*StoredLogin{a, b} {
		wg.Add(1)
		go func(s *StoredLogin) {
			defer wg.Done()
			if _, err := s.Invalidate(context.Background(), "access-0"); err != nil {
				errs <- err
			}
		}(s)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("Invalidate: %v", err)
	}
	if rs.calls != 1 {
		t.Errorf("server saw %d refreshes, want 1 (the second process adopts the first's rotation)", rs.calls)
	}
	disk, err := LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if disk.RefreshToken != rs.current {
		t.Fatalf("stored refresh token %q is not the server's current %q", disk.RefreshToken, rs.current)
	}

	// The grace window closes; a later refresh (new process) must succeed.
	rs.mu.Lock()
	rs.grace = 0
	rs.mu.Unlock()
	later := quiet(NewStoredLogin(srv.URL, path, disk))
	if _, err := later.Invalidate(context.Background(), disk.AccessToken); err != nil {
		t.Fatalf("refresh after grace window: %v (session revoked: %v)", err, rs.revoked)
	}
	if rs.revoked {
		t.Fatal("session was revoked as stolen")
	}
}

func TestStoredLoginGracePathNeverRewritesRefreshToken(t *testing.T) {
	path, c := seedLogin(t)
	rs := &rotatingServer{current: "refresh-0", graceOnly: true}
	srv := startRotating(t, rs)
	s := quiet(NewStoredLogin(srv.URL, path, c))
	tok, err := s.Invalidate(context.Background(), "access-0")
	if err != nil {
		t.Fatalf("Invalidate: %v", err)
	}
	disk, err := LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if disk.RefreshToken != "refresh-0" || disk.AccessToken != tok {
		t.Errorf("disk = %+v, want refresh-0 kept and access %q", disk, tok)
	}
}

func TestStoredLoginSingleFlightInProcess(t *testing.T) {
	path, c := seedLogin(t)
	rs := &rotatingServer{current: "refresh-0", grace: time.Hour}
	srv := startRotating(t, rs)
	s := quiet(NewStoredLogin(srv.URL, path, c))
	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.Invalidate(context.Background(), "access-0"); err != nil {
				t.Errorf("Invalidate: %v", err)
			}
		}()
	}
	wg.Wait()
	if rs.calls != 1 {
		t.Errorf("server saw %d refreshes for one rejected token, want 1", rs.calls)
	}
}

func TestStoredLoginPasswordMethodCannotRefresh(t *testing.T) {
	path, c := seedLogin(t)
	c.Method = MethodPassword
	s := quiet(NewStoredLogin("http://unused.invalid", path, c))
	_, err := s.Invalidate(context.Background(), c.AccessToken)
	if err == nil || !strings.Contains(err.Error(), "dftstream login") {
		t.Errorf("err = %v, want a log-in-again error", err)
	}
}

func TestStoredLoginMisconfiguredBackendIsNamed(t *testing.T) {
	path, c := seedLogin(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		if _, err := w.Write([]byte(`{"error":"CLI token signing is not configured on this deployment"}`)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	t.Cleanup(srv.Close)
	s := quiet(NewStoredLogin(srv.URL, path, c))
	_, err := s.Invalidate(context.Background(), c.AccessToken)
	if err == nil || !strings.Contains(err.Error(), "signing is not configured") {
		t.Errorf("err = %v, want the backend's reason", err)
	}
}
