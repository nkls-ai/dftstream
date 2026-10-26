package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigFileMissing(t *testing.T) {
	cfg, err := loadConfigFile(filepath.Join(t.TempDir(), "nonexistent.json"))
	if err != nil {
		t.Fatalf("loadConfigFile for missing file returned error: %v", err)
	}
	if cfg.ConvexURL != "" {
		t.Fatalf("expected empty config, got %+v", cfg)
	}
}

func TestLoadConfigFileValid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"convexUrl":"https://example.convex.cloud"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfigFile(path)
	if err != nil {
		t.Fatalf("loadConfigFile: %v", err)
	}
	if cfg.ConvexURL != "https://example.convex.cloud" {
		t.Fatalf("ConvexURL = %q, want https://example.convex.cloud", cfg.ConvexURL)
	}
}

func TestSaveAndLoadConfigFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "config.json")
	t.Setenv("DFTSTREAM_UI_CONFIG", path)

	cfg := appConfig{ConvexURL: "http://localhost:3210"}
	if err := saveConfigFile(cfg); err != nil {
		t.Fatalf("saveConfigFile: %v", err)
	}

	loaded, err := loadConfigFile("")
	if err != nil {
		t.Fatalf("loadConfigFile after save: %v", err)
	}
	if loaded.ConvexURL != cfg.ConvexURL {
		t.Fatalf("round-trip failed: got %q, want %q", loaded.ConvexURL, cfg.ConvexURL)
	}
}

func TestResolveTrackerURLFromConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{"convexUrl":"http://remote:3210"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DFTSTREAM_UI_CONFIG", path)
	t.Setenv("DFTSTREAM_TRACKER_URL", "")

	got := resolveTrackerURL("")
	if got != "convex+http://remote:3210" {
		t.Fatalf("resolveTrackerURL = %q, want convex+http://remote:3210", got)
	}
}
