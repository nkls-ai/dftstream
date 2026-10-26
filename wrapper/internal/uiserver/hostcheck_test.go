package uiserver

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestAllowedHost(t *testing.T) {
	cases := []struct {
		name    string
		host    string
		allowed string
		ok      bool
	}{
		{"localhost with port", "localhost:3000", "127.0.0.1:3000", true},
		{"localhost bare", "localhost", "127.0.0.1:3000", true},
		{"localhost subdomain", "app.localhost:3000", "127.0.0.1:3000", true},
		{"loopback v4", "127.0.0.1:3000", "127.0.0.1:3000", true},
		{"loopback v6", "[::1]:3000", "127.0.0.1:3000", true},
		{"lan ip literal", "192.168.1.5:3000", "0.0.0.0:3000", true},
		{"public ip literal", "203.0.113.7:3000", "0.0.0.0:3000", true},
		{"configured listen name", "chem-ws.example:3000", "chem-ws.example:3000", true},
		{"configured name case-insensitive", "CHEM-WS.example:3000", "chem-ws.example:3000", true},
		{"rebinding domain", "attacker.example:3000", "127.0.0.1:3000", false},
		{"rebinding domain no port", "attacker.example", "127.0.0.1:3000", false},
		{"rebinding domain vs wildcard bind", "attacker.example:3000", "0.0.0.0:3000", false},
		{"not the configured name", "other.example:3000", "chem-ws.example:3000", false},
		{"empty host", "", "127.0.0.1:3000", false},
		{"localhost lookalike", "notlocalhost:3000", "127.0.0.1:3000", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := allowedHost(tc.host, tc.allowed); got != tc.ok {
				t.Errorf("allowedHost(%q, %q) = %v, want %v", tc.host, tc.allowed, got, tc.ok)
			}
		})
	}
}

// The Host check must cover the whole mux — a DNS-rebound page must not be
// able to read /api/local-file (or anything else) under a foreign name.
func TestHandlerRejectsForeignHostHeader(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "traj.xyz")
	if err := os.WriteFile(path, []byte("1\nc\nH 0 0 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := Handler(Config{ConvexURL: "http://127.0.0.1:3210", LocalFileEnabled: true, AllowedHost: "127.0.0.1:3000"})

	do := func(target, host string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.Host = host
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}

	for _, target := range []string{"/", "/dftstream-config.json", "/healthz", "/api/local-file?path=" + path} {
		if rr := do(target, "attacker.example:3000"); rr.Code != http.StatusForbidden {
			t.Errorf("GET %s with rebound Host = %d, want 403", target, rr.Code)
		}
	}

	if rr := do("/api/local-file?path="+path, "localhost:3000"); rr.Code != http.StatusOK {
		t.Errorf("GET local-file with Host localhost = %d %q, want 200", rr.Code, rr.Body.String())
	}
	if rr := do("/healthz", "127.0.0.1:3000"); rr.Code != http.StatusOK {
		t.Errorf("GET /healthz with loopback Host = %d, want 200", rr.Code)
	}
}
