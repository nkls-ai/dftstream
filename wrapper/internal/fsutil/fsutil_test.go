package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCopyFileCopiesContent(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.txt")
	dst := filepath.Join(dir, "dst.txt")
	if err := os.WriteFile(src, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := CopyFile(src, dst); err != nil {
		t.Fatalf("CopyFile: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "payload" {
		t.Fatalf("dst content = %q, want %q", got, "payload")
	}
}

func TestCopyFileTruncatesExistingDst(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.txt")
	dst := filepath.Join(dir, "dst.txt")
	if err := os.WriteFile(src, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("old-longer-content"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := CopyFile(src, dst); err != nil {
		t.Fatalf("CopyFile: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Fatalf("dst content = %q, want %q", got, "new")
	}
}

func TestCopyFileMissingSrcErrors(t *testing.T) {
	dir := t.TempDir()
	if err := CopyFile(filepath.Join(dir, "absent"), filepath.Join(dir, "dst")); err == nil {
		t.Fatal("CopyFile of missing source succeeded")
	}
}
