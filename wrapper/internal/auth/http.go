package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/nkls-ai/dftstream/internal/stringutil"
)

// httpTimeout bounds one credential HTTP round trip. Refreshes run while the
// credentials lock is held, so an unbounded request would wedge every other
// process sharing the file.
const httpTimeout = 30 * time.Second

var httpClient = &http.Client{Timeout: httpTimeout}

// SiteURL derives the Convex *site* origin (where HTTP actions like
// /cli/link/* live) from the deployment URL, overridable via
// DFTSTREAM_CONVEX_SITE_URL:
//
//   - cloud: the .convex.site sibling of .convex.cloud;
//   - self-hosted / local with an explicit port: the next port up. That is
//     how every Convex backend binary lays out its two listeners — `convex
//     dev` local deployments (3210 → 3211), the self-hosted image (3210 →
//     3211) and db/docker here (16767 → 16768). Assuming the same port sent
//     `dftstream login` against a default local backend to a 404;
//   - anything else (typically a reverse proxy on a default port): the same
//     origin.
func SiteURL(convexURL string) string {
	if override := strings.TrimSpace(os.Getenv(EnvSiteURL)); override != "" {
		return strings.TrimRight(override, "/")
	}
	u := strings.TrimRight(convexURL, "/")
	u = strings.TrimPrefix(u, "convex+")
	if strings.Contains(u, ".convex.cloud") {
		return strings.Replace(u, ".convex.cloud", ".convex.site", 1)
	}
	parsed, err := url.Parse(u)
	if err != nil || parsed.Port() == "" {
		// Unparseable or port-less: nothing to derive from; same origin.
		return u
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port <= 0 || port >= 65535 {
		// Not a usable numeric port (url.Parse accepts odd ones); same origin.
		return u
	}
	parsed.Host = parsed.Hostname() + ":" + strconv.Itoa(port+1)
	if strings.Contains(parsed.Hostname(), ":") {
		// IPv6 literal: the brackets Hostname() stripped must come back.
		parsed.Host = "[" + parsed.Hostname() + "]:" + strconv.Itoa(port+1)
	}
	return strings.TrimRight(parsed.String(), "/")
}

// PostJSON POSTs a JSON body and returns the response body plus the HTTP
// status. A status >= 400 is also returned as an error (status preserved so
// callers can branch on it); status 0 means no HTTP response at all.
func PostJSON(ctx context.Context, url string, body any) (json.RawMessage, int, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			// Read-side close after a full read loses nothing; note it anyway.
			fmt.Fprintf(os.Stderr, "warning: closing response body: %v\n", closeErr) //nolint:errcheck — write to stderr is best-effort
		}
	}()
	out, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		return nil, resp.StatusCode, readErr
	}
	if resp.StatusCode >= 400 {
		return out, resp.StatusCode, fmt.Errorf("HTTP %d: %s", resp.StatusCode, stringutil.Truncate(out, 200))
	}
	return out, resp.StatusCode, nil
}

// BackendError extracts the backend's own `{"error": "..."}` message from a
// response body, or "" when the body is not one (e.g. a proxy's HTML page).
func BackendError(raw []byte) string {
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return ""
	}
	return body.Error
}

// IsBackendMisconfigured reports a 503 the DFTStream backend itself sent
// (JSON error body), which means the deployment cannot mint tokens at all —
// e.g. JWT_PRIVATE_KEY unset. Retrying cannot fix that. A 503 from a proxy
// (no JSON body) stays transient.
func IsBackendMisconfigured(status int, raw []byte) bool {
	return status == http.StatusServiceUnavailable && BackendError(raw) != ""
}
