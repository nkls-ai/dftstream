package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

// StoredLogin is the credentials.json source written by `dftstream login`.
//
// The backend ROTATES the refresh token on every redemption, and a
// superseded token replayed after a short grace window revokes the whole
// session as stolen. So every refresh must (1) present the newest token any
// process has persisted and (2) persist its own rotation before anyone else
// can read the file. Both hold only if read → refresh → write is atomic across
// every process sharing the file, which is what the flock in Invalidate buys.
type StoredLogin struct {
	site   string
	path   string
	method Method
	warn   io.Writer

	mu      sync.Mutex
	access  string
	refresh string
	// diskAccess is the access token we last saw on disk (or wrote). A
	// different value on disk means another process refreshed since.
	diskAccess string
}

// NewStoredLogin builds the source from credentials already loaded from path.
func NewStoredLogin(site, path string, c Credentials) *StoredLogin {
	return &StoredLogin{
		site:       site,
		path:       path,
		method:     c.Method,
		warn:       os.Stderr,
		access:     c.AccessToken,
		refresh:    c.RefreshToken,
		diskAccess: c.AccessToken,
	}
}

// Token returns the current access token.
func (s *StoredLogin) Token(context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.access, nil
}

// FixHint tells the user to log in again.
func (s *StoredLogin) FixHint() string { return loginFixHint }

// Kind is KindStoredLogin.
func (s *StoredLogin) Kind() Kind { return KindStoredLogin }

// Invalidate trades the refresh token for a fresh access token after
// `rejected` got a 401, and persists the rotation.
func (s *StoredLogin) Invalidate(ctx context.Context, rejected string) (string, error) {
	if s.method != MethodBrowserLink {
		return "", errors.New("token expired; run `dftstream login` to re-authenticate")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// In-process single flight: a concurrent caller already replaced it.
	if s.access != "" && s.access != rejected {
		return s.access, nil
	}
	unlock, err := lockFile(ctx, s.path+".lock")
	if err != nil {
		return "", err
	}
	defer unlock()

	creds, loadErr := loadCredentialsAt(s.path)
	if loadErr != nil {
		// Fall back to the in-memory token; worst case the server's rotation
		// grace window covers the race. Nothing is written back below.
		fmt.Fprintf(s.warn, "warning: could not re-read credentials before refresh: %v\n", loadErr) //nolint:errcheck — write to stderr is best-effort
	} else {
		if creds.AccessToken != "" && creds.AccessToken != s.diskAccess && creds.AccessToken != rejected {
			// Another process refreshed while we waited for the lock: adopt
			// its tokens instead of spending (and rotating) the refresh token
			// again.
			s.adopt(creds)
			return s.access, nil
		}
		if creds.RefreshToken != "" {
			s.refresh = creds.RefreshToken
		}
	}
	if s.refresh == "" {
		return "", errors.New("no refresh token; run `dftstream login`")
	}

	access, rotated, err := redeemRefresh(ctx, s.site, s.refresh)
	if err != nil {
		return "", err
	}
	s.access = access
	if rotated != "" {
		s.refresh = rotated
	}
	if loadErr != nil {
		fmt.Fprintf(s.warn, "warning: could not persist refreshed tokens (read: %v); the session may not survive this process\n", loadErr) //nolint:errcheck — write to stderr is best-effort
		return access, nil
	}
	creds.AccessToken = access
	// Grace path (no rotated token): the server kept whatever refresh token
	// is current, and the one on disk is the newest we know — never rewrite
	// it with the superseded one we presented.
	if rotated != "" {
		creds.RefreshToken = rotated
	}
	if err := saveCredentialsAt(s.path, creds); err != nil {
		// The in-memory tokens carry this process to completion, but the
		// on-disk refresh token is now superseded — the NEXT process will
		// fail once the grace window closes. Say so.
		fmt.Fprintf(s.warn, "warning: could not persist refreshed tokens: %v; run `dftstream login` again if the next run cannot authenticate\n", err) //nolint:errcheck — write to stderr is best-effort
		return access, nil
	}
	s.diskAccess = access
	return access, nil
}

func (s *StoredLogin) adopt(c Credentials) {
	s.access = c.AccessToken
	s.diskAccess = c.AccessToken
	if c.RefreshToken != "" {
		s.refresh = c.RefreshToken
	}
}

// redeemRefresh POSTs /cli/link/refresh. rotated is the new refresh token,
// or "" on the backend's concurrent-refresh grace path. Its errors are not
// prefixed "refresh failed": the caller that asked for the refresh (the
// tracker's 401 path) already labels them so.
func redeemRefresh(ctx context.Context, site, refresh string) (access, rotated string, err error) {
	raw, status, err := PostJSON(ctx, site+"/cli/link/refresh", map[string]string{"refreshToken": refresh})
	if err != nil {
		if IsBackendMisconfigured(status, raw) {
			return "", "", fmt.Errorf("the backend cannot issue tokens: %s", BackendError(raw))
		}
		return "", "", fmt.Errorf("/cli/link/refresh: %w", err)
	}
	var out struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		return "", "", errors.New("refresh returned no access token")
	}
	return out.AccessToken, out.RefreshToken, nil
}
