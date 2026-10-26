package uiserver

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCheckSameOrigin(t *testing.T) {
	cases := []struct {
		name, site, origin string
		ok                 bool
	}{
		{name: "no metadata (curl)", ok: true},
		{name: "UI's own fetch", site: "same-origin", ok: true},
		{name: "typed URL", site: "none", ok: true},
		{name: "other site's page", site: "cross-site"},
		{name: "sibling subdomain", site: "same-site"},
		{name: "matching Origin", origin: "http://127.0.0.1:3000", ok: true},
		{name: "foreign Origin", origin: "https://evil.example"},
		{name: "opaque Origin", origin: "null"},
	}
	for _, tc := range cases {
		err := checkSameOrigin(tc.site, tc.origin, "127.0.0.1:3000")
		if (err == nil) != tc.ok {
			t.Errorf("%s: err = %v, want ok=%v", tc.name, err, tc.ok)
		}
	}
}

// A page on another site can aim <script src> or a no-cors fetch at the
// loopback UI server; the Host header is a valid IP literal then, so only
// fetch metadata tells it apart. It must never reach the file system.
func TestLocalFileRefusesCrossSiteRequest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret.xyz")
	if err := os.WriteFile(path, []byte("1\n\nH 0 0 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := Handler(Config{LocalFileEnabled: true, AllowedHost: "127.0.0.1:3000"})

	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3000/api/local-file?path="+path, nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("cross-site GET = %d, want 403", rr.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3000/api/local-file?path="+path, nil)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("same-origin GET = %d, want 200", rr.Code)
	}
	if got := rr.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
}
