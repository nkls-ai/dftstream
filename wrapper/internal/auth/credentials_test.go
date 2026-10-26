package auth

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCredentialsRoundTripAndPerms(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	t.Setenv("DFTSTREAM_CREDENTIALS", path)

	// Missing file is not an error — returns the zero value.
	got, err := LoadCredentials()
	if err != nil {
		t.Fatalf("loadCredentials on missing file: %v", err)
	}
	if got.AccessToken != "" {
		t.Fatalf("expected empty credentials, got %+v", got)
	}

	want := Credentials{
		Method:       MethodBrowserLink,
		AccessToken:  "acc",
		RefreshToken: "ref",
		OrgID:        "org123",
		OrgSlug:      "lab",
	}
	if err := SaveCredentials(want); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}

	// File must be owner-only (0600) since it holds bearer tokens.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("credentials perm = %o, want 600", perm)
	}

	got, err = LoadCredentials()
	if err != nil {
		t.Fatalf("loadCredentials: %v", err)
	}
	if got != want {
		t.Errorf("round-trip mismatch:\n got %+v\nwant %+v", got, want)
	}

	// Logout removes the file; a second logout is a no-op.
	if err := ClearCredentials(); err != nil {
		t.Fatalf("clearCredentials: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("expected file removed, stat err = %v", err)
	}
	if err := ClearCredentials(); err != nil {
		t.Errorf("second clearCredentials should be a no-op, got %v", err)
	}
}

func TestConvexSiteURL(t *testing.T) {
	cases := map[string]string{
		"https://x.convex.cloud":        "https://x.convex.site",
		"convex+https://y.convex.cloud": "https://y.convex.site",
		// Local / self-hosted backends serve HTTP actions on the next port
		// (regression: the same port answered /cli/link/start with a 404).
		"http://127.0.0.1:3210":        "http://127.0.0.1:3211",
		"convex+http://127.0.0.1:3210": "http://127.0.0.1:3211",
		"http://localhost:16767/":      "http://localhost:16768",
		"http://[::1]:3210":            "http://[::1]:3211",
		// No port to derive from (reverse proxy): same origin.
		"https://convex.lab.example":       "https://convex.lab.example",
		"https://convex.lab.example/base/": "https://convex.lab.example/base",
	}
	for in, want := range cases {
		if got := SiteURL(in); got != want {
			t.Errorf("SiteURL(%q) = %q, want %q", in, got, want)
		}
	}
	t.Setenv("DFTSTREAM_CONVEX_SITE_URL", "https://override.example/")
	if got := SiteURL("https://x.convex.cloud"); got != "https://override.example" {
		t.Errorf("override not honored: got %q", got)
	}
}

func TestSaveCredentialsIsAtomicAndPrivate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	t.Setenv("DFTSTREAM_CREDENTIALS", path)

	if err := SaveCredentials(Credentials{
		Method:       MethodBrowserLink,
		AccessToken:  "at-1",
		RefreshToken: "rt-1",
	}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}
	// Rotate: overwrite with a new refresh token, then verify the final state.
	if err := SaveCredentials(Credentials{
		Method:       MethodBrowserLink,
		AccessToken:  "at-2",
		RefreshToken: "rt-2",
	}); err != nil {
		t.Fatalf("saveCredentials (rotate): %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("credentials file mode = %o, want 0600", perm)
	}
	got, err := LoadCredentials()
	if err != nil {
		t.Fatalf("loadCredentials: %v", err)
	}
	if got.RefreshToken != "rt-2" || got.AccessToken != "at-2" {
		t.Errorf("rotated credentials not persisted, got %+v", got)
	}
	// The atomic write must not leave temp files behind.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "credentials.json" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("unexpected files next to credentials.json: %v", names)
	}
}
