package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"
)

// Retry ladder for the exchange: transient failures (network, 5xx) and the
// server's per-token throttle (HTTP 429 slow_down — parallel array tasks
// sharing one token WILL collide at job start) back off exponentially with
// jitter so colliding tasks spread out instead of retrying in lockstep.
const (
	machineTokenExchangeAttempts = 6
	machineTokenBackoffBase      = 500 * time.Millisecond
	machineTokenBackoffCap       = 8 * time.Second
)

// MachineTokenExchangeTimeout bounds the blocking startup exchange, retries
// included: a batch job that cannot authenticate should fail fast.
const MachineTokenExchangeTimeout = 45 * time.Second

// machineTokenFix is the actionable half of every terminal exchange error.
const machineTokenFix = "create a new token in Settings → Machine tokens and update DFTSTREAM_TOKEN"

// MachineTokenFixHint is the fix line for any auth failure while
// DFTSTREAM_TOKEN is set — advising `dftstream login` would be wrong twice
// over (login is not the failing path, and its result is shadowed).
const MachineTokenFixHint = "Replace DFTSTREAM_TOKEN (create a new token in Settings → Machine tokens), or unset it to use `dftstream login`."

// MachineToken exchanges a DFTSTREAM_TOKEN for short-lived access tokens.
// There is no refresh chain: the token itself is the long-lived credential,
// re-exchanged on every 401. Nothing touches disk.
type MachineToken struct {
	site   string
	secret string

	mu     sync.Mutex
	access string
}

// NewMachineToken exchanges secret now (so a bad token fails the command
// immediately, with a clear message) and returns the source plus the
// organization the token is bound to.
func NewMachineToken(ctx context.Context, site, secret string) (*MachineToken, string, error) {
	access, org, err := exchangeMachineToken(ctx, site, secret)
	if err != nil {
		return nil, "", err
	}
	return &MachineToken{site: site, secret: secret, access: access}, org, nil
}

// Token returns the current access token.
func (m *MachineToken) Token(context.Context) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.access, nil
}

// Invalidate re-exchanges unless another caller already replaced `rejected`.
func (m *MachineToken) Invalidate(ctx context.Context, rejected string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.access != "" && m.access != rejected {
		return m.access, nil
	}
	access, _, err := exchangeMachineToken(ctx, m.site, m.secret)
	if err != nil {
		return "", err
	}
	m.access = access
	return access, nil
}

// FixHint names DFTSTREAM_TOKEN, not `dftstream login`.
func (m *MachineToken) FixHint() string { return MachineTokenFixHint }

// Kind is KindMachineToken.
func (m *MachineToken) Kind() Kind { return KindMachineToken }

// exchangeMachineToken POSTs the machine token to /cli/token/exchange and
// returns the minted access token plus its organization. Terminal rejections
// (401 invalid, 410 revoked, backend-sent 503) name the fix; 429 and other
// 5xx retry with jittered backoff until the ladder or ctx runs out. The
// machine token itself never appears in any error or log line.
func exchangeMachineToken(ctx context.Context, siteURL, machineToken string) (string, string, error) {
	var lastErr error
	for attempt := 0; attempt < machineTokenExchangeAttempts; attempt++ {
		if attempt > 0 {
			backoff := machineTokenBackoffBase << (attempt - 1)
			if backoff > machineTokenBackoffCap {
				backoff = machineTokenBackoffCap
			}
			// Full jitter: colliding SLURM array tasks must not stay in
			// lockstep against the server's per-token throttle.
			wait := time.Duration(rand.Int64N(int64(backoff))) + backoff/2
			select {
			case <-ctx.Done():
				return "", "", fmt.Errorf("machine token exchange: %w (last error: %v)", ctx.Err(), lastErr)
			case <-time.After(wait):
			}
		}
		raw, status, err := PostJSON(ctx, siteURL+"/cli/token/exchange", map[string]string{"token": machineToken})
		switch {
		case status == http.StatusUnauthorized:
			return "", "", fmt.Errorf("DFTSTREAM_TOKEN was rejected as invalid (or its creator is no longer a member of the organization). Fix: %s", machineTokenFix)
		case status == http.StatusGone:
			return "", "", fmt.Errorf("DFTSTREAM_TOKEN has been revoked. Fix: %s", machineTokenFix)
		case IsBackendMisconfigured(status, raw):
			return "", "", fmt.Errorf("the backend cannot issue tokens: %s. Fix: ask the deployment operator to configure CLI token signing", BackendError(raw))
		case status == http.StatusTooManyRequests || status >= 500:
			// Throttle (parallel jobs sharing the token) or a mid-deploy 5xx:
			// transient, keep the ladder going.
			lastErr = err
			continue
		case err != nil:
			// Transport failures (status 0) retry; other HTTP errors are
			// terminal — a 404 here means the backend has no machine-token
			// support at all, which no retry will fix.
			if status == 0 {
				lastErr = err
				continue
			}
			if status == http.StatusNotFound {
				return "", "", fmt.Errorf("the backend does not support machine tokens (HTTP 404 from /cli/token/exchange). Fix: upgrade the DFTStream backend, or use `dftstream login`")
			}
			return "", "", fmt.Errorf("machine token exchange failed: %w", err)
		}
		var out struct {
			AccessToken    string `json:"accessToken"`
			OrganizationID string `json:"organizationId"`
		}
		if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
			return "", "", fmt.Errorf("machine token exchange returned no access token. Fix: check that the tracker URL points at a DFTStream backend")
		}
		return out.AccessToken, out.OrganizationID, nil
	}
	return "", "", fmt.Errorf("machine token exchange failed after %d attempt(s): %w", machineTokenExchangeAttempts, lastErr)
}
