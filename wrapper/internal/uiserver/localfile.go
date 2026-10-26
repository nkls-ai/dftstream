package uiserver

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// The /api/local-file endpoint lets the UI's Tools tab visualize a
// structure/trajectory file by absolute path on THIS machine — the one the
// dftstream binary runs on — so a browser reached over port forwarding can
// still open local results. Strictly read-only: ORCA outputs are never
// opened for writing (see CLAUDE.md).

// localFileMaxBytes matches the UI's UPLOAD_MAX_FILE_BYTES.
const localFileMaxBytes = 128 << 20

// localFileExts is the allowlist of extensions the endpoint will serve.
// Everything here is plain text; keeping the list tight bounds what a
// port-forwarded browser session can read off the host.
var localFileExts = map[string]bool{
	".xyz":    true,
	".trj":    true,
	".allxyz": true,
	".interp": true,
	".out":    true,
}

// validateLocalFilePath normalizes and vets a user-supplied path: absolute,
// no parent-dir escapes, allowlisted extension.
func validateLocalFilePath(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", errors.New("missing path parameter")
	}
	if strings.Contains(raw, "..") {
		return "", errors.New("path must not contain '..'")
	}
	clean := filepath.Clean(raw)
	if !filepath.IsAbs(clean) {
		return "", errors.New("path must be absolute")
	}
	ext := strings.ToLower(filepath.Ext(clean))
	if !localFileExts[ext] {
		return "", fmt.Errorf("extension %q not allowed (use .xyz, .trj, .allxyz, .interp or .out)", ext)
	}
	return clean, nil
}

func localFileHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := checkSameOrigin(r.Header.Get("Sec-Fetch-Site"), r.Header.Get("Origin"), r.Host); err != nil {
			http.Error(w, err.Error(), http.StatusForbidden)
			return
		}
		path, err := validateLocalFilePath(r.URL.Query().Get("path"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		f, err := os.Open(path)
		if err != nil {
			switch {
			case os.IsNotExist(err):
				http.Error(w, "file not found: "+path, http.StatusNotFound)
			case os.IsPermission(err):
				http.Error(w, "permission denied: "+path, http.StatusForbidden)
			default:
				http.Error(w, "cannot open file: "+err.Error(), http.StatusInternalServerError)
			}
			return
		}
		defer func() {
			// Read-only handle; nothing to lose on close, but surface it.
			if cerr := f.Close(); cerr != nil {
				fmt.Fprintf(os.Stderr, "uiserver: close %s: %v\n", path, cerr) //nolint:errcheck — write to stderr is best-effort
			}
		}()
		info, err := f.Stat()
		if err != nil {
			http.Error(w, "cannot stat file: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if info.IsDir() {
			http.Error(w, "path is a directory", http.StatusBadRequest)
			return
		}
		if info.Size() > localFileMaxBytes {
			http.Error(w, fmt.Sprintf("file is %d bytes; limit is %d", info.Size(), localFileMaxBytes), http.StatusRequestEntityTooLarge)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		// Never let a browser sniff a text body into script or style.
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-File-Size", fmt.Sprintf("%d", info.Size()))
		// ServeContent handles HEAD, Range and If-Modified-Since (304 for
		// the Tools tab's live-follow polling) from the mod time.
		http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
	}
}
