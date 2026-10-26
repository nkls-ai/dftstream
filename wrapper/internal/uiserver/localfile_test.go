package uiserver

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateLocalFilePath(t *testing.T) {
	cases := []struct {
		name string
		in   string
		ok   bool
	}{
		{"absolute xyz", "/data/run/water.xyz", true},
		{"absolute trj", "/data/run/scan_trj.trj", true},
		{"allxyz", "/data/band_MEP.allxyz", true},
		{"interp", "/data/neb.interp", true},
		{"out", "/data/job.out", true},
		{"relative", "water.xyz", false},
		{"empty", "", false},
		{"whitespace", "   ", false},
		{"parent escape", "/data/../etc/passwd.xyz", false},
		{"bad extension", "/home/user/.ssh/id_rsa", false},
		{"gbw refused", "/data/run/water.gbw", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validateLocalFilePath(tc.in)
			if tc.ok && err != nil {
				t.Errorf("validateLocalFilePath(%q) = %v, want ok", tc.in, err)
			}
			if !tc.ok && err == nil {
				t.Errorf("validateLocalFilePath(%q) succeeded, want error", tc.in)
			}
		})
	}
}

func TestLocalFileHandlerServesAndRejects(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "traj.xyz")
	const body = "1\ncomment E -1.0\nH 0 0 0\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	h := localFileHandler()

	get := func(target string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		h(rr, httptest.NewRequest(http.MethodGet, target, nil))
		return rr
	}

	if rr := get("/api/local-file?path=" + path); rr.Code != http.StatusOK || rr.Body.String() != body {
		t.Errorf("GET existing = %d %q, want 200 with file body", rr.Code, rr.Body.String())
	}
	if rr := get("/api/local-file?path=" + filepath.Join(dir, "missing.xyz")); rr.Code != http.StatusNotFound {
		t.Errorf("GET missing = %d, want 404", rr.Code)
	}
	if rr := get("/api/local-file?path=relative.xyz"); rr.Code != http.StatusBadRequest {
		t.Errorf("GET relative = %d, want 400", rr.Code)
	}
	if rr := get("/api/local-file?path=" + dir); rr.Code != http.StatusBadRequest {
		t.Errorf("GET directory = %d, want 400", rr.Code)
	}

	rr := httptest.NewRecorder()
	h(rr, httptest.NewRequest(http.MethodPost, "/api/local-file?path="+path, nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST = %d, want 405", rr.Code)
	}

	// Conditional GET: If-Modified-Since at the file's mod time -> 304.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/local-file?path="+path, nil)
	req.Header.Set("If-Modified-Since", info.ModTime().UTC().Format(http.TimeFormat))
	rr = httptest.NewRecorder()
	h(rr, req)
	if rr.Code != http.StatusNotModified {
		t.Errorf("conditional GET = %d, want 304", rr.Code)
	}
}

func TestLocalFileHandlerDirValidationMessage(t *testing.T) {
	rr := httptest.NewRecorder()
	h := localFileHandler()
	h(rr, httptest.NewRequest(http.MethodGet, "/api/local-file?path=/nonexistent/nope.gbw", nil))
	if rr.Code != http.StatusBadRequest || !strings.Contains(rr.Body.String(), "not allowed") {
		t.Errorf("bad ext = %d %q, want 400 mentioning the allowlist", rr.Code, rr.Body.String())
	}
}
