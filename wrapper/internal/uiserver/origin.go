package uiserver

import (
	"errors"
	"net/url"
	"strings"
)

// Fetch-metadata values (Sec-Fetch-Site) a browser sends for a request that
// the UI's own page did NOT originate. "none" is a typed URL / bookmark and
// "same-origin" is the UI itself; both stay allowed.
const (
	fetchSiteCrossSite = "cross-site"
	fetchSiteSameSite  = "same-site"
)

// errCrossOrigin is the refusal for a request another site's page made.
var errCrossOrigin = errors.New("cross-origin requests are not allowed")

// checkSameOrigin refuses requests a different site's page triggered.
//
// The Host check (hostCheck) stops DNS rebinding, but a page on any site can
// still point <script src>, <img> or a no-cors fetch at
// http://127.0.0.1:<port>/api/local-file — the Host header is then a
// legitimate loopback literal. The response is opaque to that page, yet the
// request still reaches the file system (existence/timing probe, and legacy
// script-MIME sniffing of a text body). Browsers label such requests with
// Sec-Fetch-Site and, for CORS-mode requests, an Origin header; both are
// forbidden headers a page cannot forge. Clients that send neither (curl, old
// browsers) are unaffected.
func checkSameOrigin(fetchSite, origin, host string) error {
	switch strings.ToLower(strings.TrimSpace(fetchSite)) {
	case fetchSiteCrossSite, fetchSiteSameSite:
		return errCrossOrigin
	}
	if origin == "" {
		return nil
	}
	u, err := url.Parse(origin)
	if err != nil || !strings.EqualFold(u.Host, host) {
		// "null" (sandboxed/opaque origins) parses with an empty host and is
		// refused here too.
		return errCrossOrigin
	}
	return nil
}
