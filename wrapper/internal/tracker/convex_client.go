package tracker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/nkls-ai/dftstream/internal/auth"
	"github.com/nkls-ai/dftstream/internal/stringutil"
	"github.com/nkls-ai/dftstream/internal/version"
)

// Convex function paths (all defined in db/convex/).
const (
	fnExperimentsEnsure          = "experiments:ensure"
	fnExperimentsEnsureBatch     = "experiments:ensureBatch"
	fnRunsFindByExperimentName   = "runs:findByExperimentAndName"
	fnRunsCreate                 = "runs:create"
	fnRunsUpdateStatus           = "runs:updateStatus"
	fnEventsAppendMany           = "events:appendMany"
	fnMetricsAppendMany          = "metrics:appendMany"
	fnGeometriesAppend           = "geometries:append"
	fnFrequenciesSetAll          = "frequencies:setAll"
	fnSysSamplesAppendMany       = "sysSamples:appendMany"
	fnLogsAppendMany             = "logs:appendMany"
	fnArtifactsSetAll            = "artifacts:setAll"
	fnArtifactsAppendToRun       = "artifacts:appendToRun"
	fnArtifactsUpsertForRun      = "artifacts:upsertForRun"
	fnArtifactsGenerateUploadURL = "artifacts:generateUploadUrl"
	fnArtifactsDeleteBlob        = "artifacts:deleteBlob"
	fnExcitedStatesSetAll        = "excitedStates:setAll"
	fnNMRShieldsSetAll           = "nmrShields:setAll"
	fnMetaVersion                = "meta:version"
)

// metaVersionTimeout bounds the startup handshake. The handshake is
// advisory — an unreachable or too-old backend degrades to a warning — so
// it must never cost more than a couple of seconds of a chemist's time.
// Deliberately shorter than the retry ladder in call() would otherwise
// take (~30 s across 8 attempts).
const metaVersionTimeout = 4 * time.Second

// maxBackoff caps the exponential retry backoff.
const maxBackoff = 15 * time.Second

// ConvexHTTPTracker talks to a Convex deployment over its raw HTTP API.
//
// Endpoints used:
//
//	POST /api/mutation   body: {"path":"module:fn","args":{...},"format":"json"}
//	POST /api/query      body: {"path":"module:fn","args":{...},"format":"json"}
//
// All public functions are defined in db/convex/.
type ConvexHTTPTracker struct {
	base       string
	hc         *http.Client
	maxRetries int

	// src supplies the bearer token for every /api call and a replacement
	// on 401. Never nil (auth.None when unauthenticated). The tracker knows
	// nothing about which credential source it is.
	src auth.TokenSource

	// orgIDs caches resolveOrg: org reference (slug or id) -> id.
	orgMu  sync.Mutex
	orgIDs map[string]string

	// warnOut receives non-fatal warnings (a blob stored uncompressed, an
	// orphan that could not be deleted). os.Stderr unless SetWarnWriter.
	warnOut io.Writer
}

func NewConvexHTTPTracker(base string) *ConvexHTTPTracker {
	return &ConvexHTTPTracker{
		base:       strings.TrimRight(base, "/"),
		hc:         &http.Client{Timeout: 30 * time.Second},
		maxRetries: 8,
		src:        auth.None{},
		warnOut:    os.Stderr,
	}
}

// SetWarnWriter redirects non-fatal warnings (default os.Stderr).
func (c *ConvexHTTPTracker) SetWarnWriter(w io.Writer) {
	if w != nil {
		c.warnOut = w
	}
}

// warnf reports a non-fatal problem with the same "[dftstream] warning:"
// prefix the rest of the wrapper uses.
func (c *ConvexHTTPTracker) warnf(format string, args ...any) {
	fmt.Fprintf(c.warnOut, "[dftstream] warning: "+format+"\n", args...) //nolint:errcheck — warning output is best-effort
}

// SetMaxRetries overrides the retry ladder length. `dftstream sync` runs it
// down to a couple of attempts: it may legitimately be invoked from a host
// with no route to the backend (the post-job hook on an offline compute
// node), where the full ladder would waste half a minute per journal.
func (c *ConvexHTTPTracker) SetMaxRetries(n int) {
	if n >= 0 {
		c.maxRetries = n
	}
}

// SetAuth installs the credential source; nil means unauthenticated. Must be
// called before the tracker is shared across goroutines.
func (c *ConvexHTTPTracker) SetAuth(src auth.TokenSource) {
	if src == nil {
		src = auth.None{}
	}
	c.src = src
}

type convexEnvelope struct {
	Status       string          `json:"status"`
	Value        json.RawMessage `json:"value"`
	ErrorMessage string          `json:"errorMessage"`
}

type convexRequest struct {
	Path   string         `json:"path"`
	Args   map[string]any `json:"args"`
	Format string         `json:"format"`
}

func (c *ConvexHTTPTracker) call(ctx context.Context, kind, path string, args map[string]any) (json.RawMessage, error) {
	url := c.base + "/api/" + kind
	body, err := json.Marshal(convexRequest{Path: path, Args: args, Format: "json"})
	if err != nil {
		return nil, err
	}

	var lastErr error
	triedRefresh := false
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		if err := c.sleepBackoff(ctx, attempt); err != nil {
			return nil, err
		}

		req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Content-Type", "application/json")
		// Identify the wrapper build on every call so a deployment's access
		// logs can attribute a bad payload to an exact binary.
		req.Header.Set("User-Agent", version.UserAgent())
		tok, err := c.authorize(ctx, req)
		if err != nil {
			return nil, fmt.Errorf("Convex function %s: %w", path, err)
		}
		resp, err := c.hc.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		buf, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("Convex function %s: failed to read response body: %w", path, readErr)
			continue
		}
		// 401: the access token expired or was rejected. Try a one-shot
		// refresh and retry immediately (without consuming a backoff attempt)
		// so a long job survives token expiry. If refresh isn't configured or
		// fails, surface an actionable auth error.
		if resp.StatusCode == 401 {
			if !triedRefresh {
				triedRefresh = true
				refreshErr := c.refreshAfter401(ctx, tok)
				if refreshErr == nil {
					attempt--
					continue
				}
				return nil, c.unauthorizedError("Convex function "+path, buf, refreshErr)
			}
			return nil, c.unauthorizedError("Convex function "+path, buf, nil)
		}
		// 560: the function threw. Deterministic, so never retried; a
		// "not authenticated" refusal becomes an AuthError.
		if resp.StatusCode == statusUDFFailed {
			return nil, c.udfFailedError(path, buf)
		}
		// 429 TooManyWrites is the per-second write-quota throttle —
		// transient, so back off and retry like a 5xx rather than failing
		// the whole upload.
		if resp.StatusCode == 429 || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("Convex function %s returned HTTP %d: %s", path, resp.StatusCode, stringutil.Truncate(buf, 200))
			continue
		}
		if resp.StatusCode >= 400 {
			return nil, fmt.Errorf("Convex function %s returned HTTP %d: %s. Fix: verify the function exists in db/convex and that Convex is running with `bun run dev` from db/", path, resp.StatusCode, stringutil.Truncate(buf, 200))
		}
		var env convexEnvelope
		if err := json.Unmarshal(buf, &env); err != nil {
			return nil, fmt.Errorf("Convex function %s returned invalid JSON: %w (body=%q). Fix: check the tracker URL %s", path, err, stringutil.Truncate(buf, 200), c.base)
		}
		if env.Status != "success" {
			return nil, c.functionError(path, env.ErrorMessage)
		}
		return env.Value, nil
	}
	return nil, fmt.Errorf("Convex function %s request failed after %d attempt(s): %w. Fix: make sure Convex is running from db/ with `bun run dev` and the tracker URL points to %s", path, c.maxRetries+1, lastErr, c.base)
}

// authorize sets the bearer header from the credential source (none when it
// yields "") and returns the token sent, so a 401 can name what was rejected.
func (c *ConvexHTTPTracker) authorize(ctx context.Context, req *http.Request) (string, error) {
	tok, err := c.src.Token(ctx)
	if err != nil {
		return "", fmt.Errorf("credentials: %w. Fix: %s", err, c.src.FixHint())
	}
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	return tok, nil
}

// refreshAfter401 asks the credential source to replace the rejected token.
func (c *ConvexHTTPTracker) refreshAfter401(ctx context.Context, rejected string) error {
	_, err := c.src.Invalidate(ctx, rejected)
	return err
}

// unauthorizedError is the definitive-401 error: it wraps ErrUnauthorized,
// carries the refresh failure (if one was attempted), and ends with the
// credential source's own fix line — never `dftstream login` advice while a
// machine token is in use.
func (c *ConvexHTTPTracker) unauthorizedError(what string, body []byte, refreshErr error) error {
	reason := ""
	if refreshErr != nil && !errors.Is(refreshErr, auth.ErrNoRefresh) {
		reason = fmt.Sprintf(" (refresh failed: %s)", withoutFix(refreshErr))
	}
	return &AuthError{
		msg: fmt.Sprintf("%s returned HTTP 401 (%v): %s%s. Fix: %s", what, ErrUnauthorized, stringutil.Truncate(body, 200), reason, c.src.FixHint()),
		Fix: c.src.FixHint(),
	}
}

// sleepBackoff waits out the exponential backoff for a retry attempt
// (1<<attempt * 100ms, capped at maxBackoff); attempt 0 does not wait.
// Returns the context error if the wait is interrupted.
func (c *ConvexHTTPTracker) sleepBackoff(ctx context.Context, attempt int) error {
	if attempt == 0 {
		return nil
	}
	backoff := time.Duration(1<<attempt) * 100 * time.Millisecond
	if backoff > maxBackoff {
		backoff = maxBackoff
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(backoff):
		return nil
	}
}

func (c *ConvexHTTPTracker) mutation(ctx context.Context, path string, args map[string]any) (json.RawMessage, error) {
	return c.call(ctx, "mutation", path, args)
}

func (c *ConvexHTTPTracker) query(ctx context.Context, path string, args map[string]any) (json.RawMessage, error) {
	return c.call(ctx, "query", path, args)
}

// put helpers: add a key to a Convex args map only when the value is
// actually set, so absent fields stay absent on the wire (Convex
// validators treat missing and present-but-zero differently).

// BackendVersion is what `meta:version` reports about a deployment: the
// API contract it implements, the oldest wrapper contract it still
// serves, and any additive capability names.
type BackendVersion struct {
	APIVersion           int      `json:"apiVersion"`
	MinWrapperAPIVersion int      `json:"minWrapperApiVersion"`
	Features             []string `json:"features"`
}

// HasFeature reports whether the backend advertises the named additive
// capability. Unknown names are false, which is the safe answer: callers
// treat a missing name as "this deployment cannot do that yet".
func (b BackendVersion) HasFeature(name string) bool {
	for _, f := range b.Features {
		if f == name {
			return true
		}
	}
	return false
}

// ErrVersionUnsupported means the handshake could not be performed at
// all — the tracker has no backend to ask (noop://), or the deployment
// predates meta:version. Callers must treat it as "unknown, carry on",
// never as a mismatch: losing tracking over an unanswered handshake is
// worse than running against a slightly stale backend.
var ErrVersionUnsupported = errors.New("backend does not report a version")

// VersionReporter is implemented by trackers that can answer the
// wrapper↔backend handshake. Trackers that cannot (noop, and any wrapper
// around a backend that predates meta:version) return
// ErrVersionUnsupported.
type VersionReporter interface {
	BackendVersion(ctx context.Context) (BackendVersion, error)
}

// BackendVersion performs the startup handshake against meta:version.
//
// It uses its own short timeout rather than the caller's context deadline
// so a down or hanging backend costs seconds, not the full retry ladder;
// every failure (network, 404 on a deployment without meta.ts, malformed
// body) collapses to ErrVersionUnsupported so the caller has exactly one
// "unknown" case to handle.
func (c *ConvexHTTPTracker) BackendVersion(ctx context.Context) (BackendVersion, error) {
	qctx, cancel := context.WithTimeout(ctx, metaVersionTimeout)
	defer cancel()
	raw, err := c.query(qctx, fnMetaVersion, map[string]any{})
	if err != nil {
		return BackendVersion{}, fmt.Errorf("%w: %v", ErrVersionUnsupported, err)
	}
	var bv BackendVersion
	if err := json.Unmarshal(raw, &bv); err != nil {
		return BackendVersion{}, fmt.Errorf("%w: decode meta:version: %v", ErrVersionUnsupported, err)
	}
	if bv.APIVersion <= 0 {
		return BackendVersion{}, fmt.Errorf("%w: meta:version reported apiVersion %d", ErrVersionUnsupported, bv.APIVersion)
	}
	return bv, nil
}

func (c *ConvexHTTPTracker) Close(context.Context) error { return nil }

var _ Tracker = (*ConvexHTTPTracker)(nil)
var _ BulkAppender = (*ConvexHTTPTracker)(nil)

// BulkAppender is implemented by backends that can persist a whole batch of
// append-style rows in one call. BatchingTracker prefers it over the per-row
// Tracker methods; the spool journal implements it too, so a batch written
// while offline becomes a single journal record instead of N.
type BulkAppender interface {
	AppendEvents(ctx context.Context, runID RunID, events []Event) error
	AppendMetrics(ctx context.Context, runID RunID, metrics []Metric) error
	AppendSysSamples(ctx context.Context, runID RunID, samples []SysSample) error
	AppendLogs(ctx context.Context, runID RunID, entries []LogEntry) error
}
