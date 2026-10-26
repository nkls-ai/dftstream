package auth

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// A credentials.json left world-readable (older versions, a copy, a restored
// backup) must warn, and end up 0600 after the next save.
func TestLoosePermsWarnAndSaveTightens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "credentials.json")
	t.Setenv(EnvCredentialsPath, path)
	if err := os.WriteFile(path, []byte(`{"method":"browser-link","accessToken":"a","refreshToken":"r"}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	var warn strings.Builder
	prevOut := permWarnOut
	permWarnOut = &warn
	permWarnOnce = sync.Once{}
	t.Cleanup(func() { permWarnOut = prevOut; permWarnOnce = sync.Once{} })

	c, err := LoadCredentials()
	if err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if !strings.Contains(warn.String(), "chmod 600") {
		t.Errorf("no loose-permission warning, got %q", warn.String())
	}
	if err := SaveCredentials(c); err != nil {
		t.Fatalf("SaveCredentials: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode after save = %o, want 600", perm)
	}
	// Once tight, no further warning.
	warn.Reset()
	permWarnOnce = sync.Once{}
	if _, err := LoadCredentials(); err != nil {
		t.Fatalf("LoadCredentials: %v", err)
	}
	if warn.Len() != 0 {
		t.Errorf("warned about a 0600 file: %q", warn.String())
	}
}
