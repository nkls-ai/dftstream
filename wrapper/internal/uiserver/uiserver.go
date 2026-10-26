// Package uiserver embeds the built UI bundle and serves it over HTTP.
//
// The dist/ directory is populated by `make ui-build` (which runs
// `bun run build` in ui/ and copies the result here). The embed
// directives require dist/index.html to exist at compile time, so a
// `go build` from a fresh checkout will fail unless `make ui-build`
// has run first — that's intentional, every shipped binary must
// contain the UI.
//
// At runtime the server:
//   - serves static assets verbatim from the embedded FS;
//   - serves /dftstream-config.json carrying the configured Convex URL
//     so the UI bundle can wire up its client at boot;
//   - serves index.html for every other path so the React router can
//     handle deep links (SPA fallback). Asset references in index.html
//     are rewritten from "./" to "/" so the fallback doesn't break
//     relative paths on deep routes.
package uiserver

import (
	"bytes"
	"embed"
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"strings"
)

// The index.html directive is the compile-time guarantee that the UI
// has been built. The all:dist directive picks up every fingerprinted
// asset (JS/CSS/images) alongside it. Both populate the same FS.
//
//go:embed dist/index.html
//go:embed all:dist
var distFS embed.FS

// Config carries values injected into the page at request time.
type Config struct {
	ConvexURL      string `json:"convexUrl"`
	Version        string `json:"version,omitempty"`
	ErrorReportURL string `json:"errorReportUrl,omitempty"`
	// Auth: AuthRequired mounts the login gate in the UI; AuthProvider selects
	// which provider component to mount ("convex" or "clerk"); ClerkPublishableKey
	// is only needed for the clerk provider. All empty/false for a single-user
	// local deployment, which then skips auth entirely.
	AuthRequired        bool   `json:"authRequired,omitempty"`
	AuthProvider        string `json:"authProvider,omitempty"`
	ClerkPublishableKey string `json:"clerkPublishableKey,omitempty"`
	// LocalFileEnabled mounts /api/local-file (Tools tab: visualize a file
	// by absolute path on this host) and advertises it to the UI.
	LocalFileEnabled bool `json:"localFileEnabled,omitempty"`
	// AllowedHost is the hostname part of the configured listen address.
	// Requests whose Host header names anything else (other than loopback
	// aliases or an IP literal) are rejected — see allowedHost. Never
	// serialized to the UI.
	AllowedHost string `json:"-"`
}

// Handler returns an http.Handler that serves the embedded UI bundle.
func Handler(cfg Config) http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	raw, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		// This is unreachable in practice — the embed directive above
		// guarantees the file exists at compile time. Panic to flag
		// any future refactor that breaks the invariant.
		panic("uiserver: dist/index.html missing despite go:embed guarantee: " + err.Error())
	}
	indexBytes := rewriteAssetPaths(raw)

	fileServer := http.FileServer(http.FS(sub))

	mux := http.NewServeMux()

	mux.HandleFunc("/dftstream-config.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		// best-effort: client may have disconnected
		if err := json.NewEncoder(w).Encode(cfg); err != nil {
			return
		}
	})

	if cfg.LocalFileEnabled {
		mux.HandleFunc("/api/local-file", localFileHandler())
	}

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok")) //nolint:errcheck — best-effort health response
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Existing files (hashed JS/CSS/images) go through the file
		// server. Everything else (root path + React router deep
		// links) falls back to index.html.
		if r.URL.Path != "/" {
			clean := strings.TrimPrefix(r.URL.Path, "/")
			if info, err := fs.Stat(sub, clean); err == nil && !info.IsDir() {
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(indexBytes) //nolint:errcheck — best-effort SPA fallback
	})

	return hostCheck(cfg.AllowedHost, mux)
}

// hostCheck rejects requests whose Host header does not name this server.
//
// A browser lured to attacker.example whose DNS answer is re-pointed at
// this server's IP (DNS rebinding) sends `Host: attacker.example` — and
// the same-origin policy, keyed on that name, no longer stands between
// the attacker's script and endpoints like /api/local-file. The Host
// header is the one thing rebinding cannot forge, so refusing unknown
// names closes the hole. Applied to the whole mux: nothing this server
// hosts is meant to be reached under a foreign name.
func hostCheck(allowed string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedHost(r.Host, allowed) {
			http.Error(w, "forbidden: unrecognized Host header", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// allowedHost reports whether the request's Host header names this
// server. Allowed:
//   - loopback names: localhost and *.localhost;
//   - any IP literal — a browser that connected via an IP sends that IP,
//     and rebinding requires a DNS name, so literals are safe;
//   - the hostname of the configured listen address (so an operator who
//     binds `--addr chem-ws.example:3000` keeps that name working).
func allowedHost(hostport, allowed string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return true
	}
	if net.ParseIP(host) != nil {
		return true
	}
	allowedName := allowed
	if h, _, err := net.SplitHostPort(allowed); err == nil {
		allowedName = h
	}
	return allowedName != "" && strings.EqualFold(host, allowedName)
}

// rewriteAssetPaths rewrites `href="./..."` and `src="./..."` in the
// built index.html to absolute paths so SPA-fallback requests served
// at deep URLs (e.g. /experiments/abc/run/def) still resolve assets
// from the bundle root.
func rewriteAssetPaths(b []byte) []byte {
	out := b
	out = bytes.ReplaceAll(out, []byte(`href="./`), []byte(`href="/`))
	out = bytes.ReplaceAll(out, []byte(`src="./`), []byte(`src="/`))
	return out
}
