package tracker

import (
	"fmt"
	"net/url"

	"github.com/nkls-ai/dftstream/internal/auth"
)

// Open returns a Tracker for the given DSN (no auth).
func Open(dsn string) (Tracker, error) {
	return OpenWithAuth(dsn, nil)
}

// OpenWithAuth returns a Tracker for the given DSN, attaching the credential
// source to the Convex HTTP tracker (nil = unauthenticated).
//
// Supported schemes:
//
//	convex+http://host:port   Convex HTTP REST endpoints (default)
//	convex+https://host:port  Convex HTTP REST endpoints over TLS
//	noop://                   Discard everything (for overhead tests)
func OpenWithAuth(dsn string, src auth.TokenSource) (Tracker, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid tracker DSN %q: %w. Fix: use `convex+http://127.0.0.1:3210` for local Convex or `noop://` for offline tests", dsn, err)
	}
	switch u.Scheme {
	case "convex+http", "convex+https":
		ct, err := OpenConvex(dsn, src)
		if err != nil {
			return nil, err
		}
		return WrapBatching(ct), nil
	case "noop":
		return NewNoopTracker(), nil
	default:
		return nil, fmt.Errorf("unsupported tracker scheme %q (DSN %q). Fix: use `convex+http://127.0.0.1:3210`, `convex+https://...`, or `noop://`", u.Scheme, dsn)
	}
}

// OpenConvex opens the raw (unbatched) Convex HTTP tracker for a convex+http
// or convex+https DSN. Callers that need the concrete type — the spool
// failover wrapper, and `dftstream sync`'s replay (which uses the Spool*
// guarded mutations) — open through here and add their own batching on top.
func OpenConvex(dsn string, src auth.TokenSource) (*ConvexHTTPTracker, error) {
	u, err := url.Parse(dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid tracker DSN %q: %w. Fix: use `convex+http://127.0.0.1:3210` for local Convex", dsn, err)
	}
	var scheme string
	switch u.Scheme {
	case "convex+http":
		scheme = "http://"
	case "convex+https":
		scheme = "https://"
	default:
		return nil, fmt.Errorf("tracker DSN %q is not a Convex backend (scheme %q). Fix: use `convex+http://host:port` or `convex+https://host:port`", dsn, u.Scheme)
	}
	ct := NewConvexHTTPTracker(scheme + u.Host)
	ct.SetAuth(src)
	return ct, nil
}
