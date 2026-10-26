package artifacts

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/levels"
)

func TestReadCappedReadsUpToLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "large.out")
	body := bytes.Repeat([]byte("a"), 8192)
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := readCapped(path, 4096)
	if err != nil {
		t.Fatalf("readCapped: %v", err)
	}
	if len(got) != 4096 {
		t.Fatalf("read length = %d, want 4096", len(got))
	}
	if !bytes.Equal(got, body[:4096]) {
		t.Fatal("readCapped returned unexpected bytes")
	}
}

func TestClassifyGoatArtifacts(t *testing.T) {
	if got := classify("job.globalminimum.xyz", "job"); got != "goat_minimum" {
		t.Fatalf("global minimum kind = %q, want goat_minimum", got)
	}
	if got := classify("job.finalensemble.xyz", "job"); got != "goat_ensemble" {
		t.Fatalf("final ensemble kind = %q, want goat_ensemble", got)
	}
	if got := classify("job.finalensemble.globaliter.2.xyz", "job"); got != "goat_ensemble" {
		t.Fatalf("global iteration ensemble kind = %q, want goat_ensemble", got)
	}
}

func TestAttachContentSmallBodyStaysInline(t *testing.T) {
	art := &Artifact{Name: "small.inp", SizeBytes: 5}
	AttachContent(art, []byte("hello"))

	if art.ContentText != "hello" {
		t.Fatalf("ContentText = %q, want hello", art.ContentText)
	}
	if art.Body != nil {
		t.Fatalf("Body = %v, want nil for an inline-sized body", art.Body)
	}
	if art.Truncated {
		t.Fatal("Truncated should be false when the whole file fit inline")
	}
}

func TestAttachContentLargeBodyKeepsPreviewAndFullBody(t *testing.T) {
	full := bytes.Repeat([]byte("x"), InlinePreviewBytes+1000)
	art := &Artifact{Name: "big.out", SizeBytes: int64(len(full))}
	AttachContent(art, full)

	if len(art.ContentText) != InlinePreviewBytes {
		t.Fatalf("preview length = %d, want %d", len(art.ContentText), InlinePreviewBytes)
	}
	if len(art.Body) != len(full) {
		t.Fatalf("Body length = %d, want %d (the whole body, not just the tail)", len(art.Body), len(full))
	}
	if !bytes.Equal(art.Body, full) {
		t.Fatal("Body should be the complete file, preview-prefix included")
	}
	if art.Truncated {
		t.Fatal("Truncated should be false when the full body was captured")
	}
}

func TestAttachContentSetsTruncatedWhenSourceWasLarger(t *testing.T) {
	// Body is the capped read; originalSize claims the file was bigger.
	captured := bytes.Repeat([]byte("x"), InlinePreviewBytes+10)
	art := &Artifact{Name: "huge.out", SizeBytes: int64(len(captured) + 999)}
	populateContent(art, captured, art.SizeBytes)

	if !art.Truncated {
		t.Fatal("Truncated should be true when originalSize exceeds the captured body")
	}
	if len(art.Body) != len(captured) {
		t.Fatalf("Body length = %d, want %d", len(art.Body), len(captured))
	}
}

// An unreadable body used to be swallowed whole: Collect kept the
// `if err == nil` branch and appended the artifact anyway, so a .out the
// wrapper could not open went to the backend as a row with empty
// ContentText, no Body, and Truncated false — indistinguishable from a
// run that produced an empty output, with nothing logged anywhere.
func TestCollectReportsUnreadableBodies(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the permission bits this test relies on")
	}
	dir := t.TempDir()
	good := filepath.Join(dir, "job.inp")
	if err := os.WriteFile(good, []byte("! HF\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(dir, "job.out")
	if err := os.WriteFile(bad, []byte("ORCA TERMINATED NORMALLY\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(bad, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(bad, 0o644); err != nil {
			t.Logf("restore mode: %v", err)
		}
	})

	arts, err := Collect(dir, "job", time.Time{}, levels.ArtifactsAll)
	if err == nil {
		t.Fatal("Collect returned no error for an unreadable body")
	}
	if !strings.Contains(err.Error(), "job.out") {
		t.Errorf("error %q does not name the unreadable file", err)
	}

	// The rest of the manifest must survive the failure.
	byName := map[string]Artifact{}
	for _, a := range arts {
		byName[a.Name] = a
	}
	if len(arts) != 2 {
		t.Fatalf("got %d artifacts, want 2: %+v", len(arts), arts)
	}
	if got := byName["job.inp"].ContentText; got != "! HF\n" {
		t.Errorf("readable artifact lost its content: %q", got)
	}
	out := byName["job.out"]
	if out.ContentText != "" || out.Body != nil {
		t.Errorf("unreadable artifact claims content: %q / %d bytes", out.ContentText, len(out.Body))
	}
	if !out.Truncated {
		t.Error("unreadable artifact is not flagged Truncated, so it looks like a complete empty file")
	}
}
