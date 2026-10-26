package artifacts

import (
	"bytes"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// repoRoot resolves the repository root from the package directory and
// verifies it, so a case that skips is genuinely a missing fixture rather
// than a wrong path.
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "wrapper", "go.mod")); err != nil {
		t.Fatalf("repo root %s does not look like the checkout: %v", root, err)
	}
	return root
}

// exampleLogs lists every file under example_logs/ that the collector would
// treat as compressible text.
func exampleLogs(t *testing.T) []string {
	t.Helper()
	dir := filepath.Join(repoRoot(t), "example_logs")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Skipf("example_logs unavailable: %v", err)
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() || !Compressible(e.Name()) {
			continue
		}
		out = append(out, filepath.Join(dir, e.Name()))
	}
	if len(out) == 0 {
		t.Skip("no compressible fixtures in example_logs")
	}
	return out
}

// TestCompressRoundTripsRealORCAOutput is the load-bearing guarantee: every
// byte that goes into the compressor comes back out identical. Run over the
// real ORCA fixtures, including the 23 MB TS output.
func TestCompressRoundTripsRealORCAOutput(t *testing.T) {
	for _, path := range exampleLogs(t) {
		t.Run(filepath.Base(path), func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			var enc bytes.Buffer
			n, err := Compress(&enc, bytes.NewReader(raw))
			if err != nil {
				t.Fatalf("Compress: %v", err)
			}
			if n != int64(enc.Len()) {
				t.Fatalf("Compress reported %d bytes, wrote %d", n, enc.Len())
			}
			var back bytes.Buffer
			if _, err := Decompress(&back, bytes.NewReader(enc.Bytes())); err != nil {
				t.Fatalf("Decompress: %v", err)
			}
			if !bytes.Equal(back.Bytes(), raw) {
				t.Fatalf("round trip lost data: got %d bytes, want %d", back.Len(), len(raw))
			}
		})
	}
}

// TestCompressLeavesORCAFilesUntouched pins the project's hardest rule: we
// compress OUR COPY on the way to storage. The chemist's file on disk must be
// byte-for-byte and mtime identical afterwards.
func TestCompressLeavesORCAFilesUntouched(t *testing.T) {
	// Work on a copy of a fixture so the test itself cannot damage the
	// tracked file even if the assertion is wrong.
	src := filepath.Join(repoRoot(t), "example_logs", "water_hf_def2svp_opt_freq.out")
	raw, err := os.ReadFile(src)
	if err != nil {
		t.Skipf("fixture unavailable: %v", err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "water_hf_def2svp_opt_freq.out")
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatalf("stage copy: %v", err)
	}
	stamp := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatalf("stamp copy: %v", err)
	}
	before := sha256.Sum256(raw)

	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	var sink bytes.Buffer
	_, cErr := Compress(&sink, f)
	if closeErr := f.Close(); closeErr != nil {
		t.Fatalf("close source: %v", closeErr)
	}
	if cErr != nil {
		t.Fatalf("Compress: %v", cErr)
	}
	// And the full staging path, which is what production actually calls.
	encoded, err := EncodeBody(filepath.Base(path), raw)
	if err != nil {
		t.Fatalf("EncodeBody: %v", err)
	}
	if _, err := io.Copy(io.Discard, encoded.Reader); err != nil {
		t.Fatalf("drain staged body: %v", err)
	}
	if err := encoded.Close(); err != nil {
		t.Fatalf("close staged body: %v", err)
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if sha256.Sum256(after) != before {
		t.Fatal("the ORCA output on disk changed — compression must never write to it")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !info.ModTime().Equal(stamp) {
		t.Fatalf("mtime = %v, want %v (untouched)", info.ModTime(), stamp)
	}
}

func TestEncodeBodyCompressesTextAndReportsSize(t *testing.T) {
	src := filepath.Join(repoRoot(t), "example_logs", "water_hf_def2svp_opt_freq.out")
	raw, err := os.ReadFile(src)
	if err != nil {
		t.Skipf("fixture unavailable: %v", err)
	}
	encoded, err := EncodeBody("water_hf_def2svp_opt_freq.out", raw)
	if err != nil {
		t.Fatalf("EncodeBody: %v", err)
	}
	defer func() {
		if err := encoded.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	}()
	if encoded.Encoding != EncodingZstd {
		t.Fatalf("encoding = %q, want zstd", encoded.Encoding)
	}
	staged, err := io.ReadAll(encoded.Reader)
	if err != nil {
		t.Fatalf("read staged body: %v", err)
	}
	if int64(len(staged)) != encoded.Size {
		t.Fatalf("staged %d bytes, Size says %d", len(staged), encoded.Size)
	}
	if encoded.Size >= int64(len(raw)) {
		t.Fatalf("compressed size %d is not smaller than raw %d", encoded.Size, len(raw))
	}
	var back bytes.Buffer
	if _, err := Decompress(&back, bytes.NewReader(staged)); err != nil {
		t.Fatalf("Decompress: %v", err)
	}
	if !bytes.Equal(back.Bytes(), raw) {
		t.Fatal("EncodeBody round trip lost data")
	}
}

func TestEncodeBodySpillsLargeBodyToDiskAndRoundTrips(t *testing.T) {
	src := filepath.Join(repoRoot(t), "example_logs", "TS_A1_CO2_bending_H_plus_Trial_3.out")
	raw, err := os.ReadFile(src)
	if err != nil {
		t.Skipf("fixture unavailable: %v", err)
	}
	if len(raw) < SpillToDiskBytes {
		t.Skipf("fixture is %d bytes, below the %d spill threshold", len(raw), SpillToDiskBytes)
	}
	encoded, err := EncodeBody("TS_A1_CO2_bending_H_plus_Trial_3.out", raw)
	if err != nil {
		t.Fatalf("EncodeBody: %v", err)
	}
	if _, isFile := encoded.Reader.(*os.File); !isFile {
		t.Fatalf("body of %d bytes should have spilled to a temp file, got %T", len(raw), encoded.Reader)
	}
	var back bytes.Buffer
	if _, err := Decompress(&back, encoded.Reader); err != nil {
		t.Fatalf("Decompress: %v", err)
	}
	if err := encoded.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if !bytes.Equal(back.Bytes(), raw) {
		t.Fatal("spilled round trip lost data")
	}
	// Re-reading after Close must fail: the staging file is gone, not leaked.
	if _, err := encoded.Reader.(*os.File).Read(make([]byte, 1)); err == nil {
		t.Fatal("staging file still readable after Close")
	}
}

func TestEncodeBodyLeavesAlreadyCompressedKindsIdentity(t *testing.T) {
	body := bytes.Repeat([]byte("compressible-looking text "), 4000)
	for _, name := range []string{"run.out.gz", "figure.png", "bundle.zip", "dump.zst", "core.gbw", "wfn.densities"} {
		encoded, err := EncodeBody(name, body)
		if err != nil {
			t.Fatalf("EncodeBody(%q): %v", name, err)
		}
		if encoded.Encoding != EncodingIdentity {
			t.Errorf("%s: encoding = %q, want identity", name, encoded.Encoding)
		}
		got, err := io.ReadAll(encoded.Reader)
		if err != nil {
			t.Fatalf("%s: read staged body: %v", name, err)
		}
		if !bytes.Equal(got, body) {
			t.Errorf("%s: identity body was altered", name)
		}
		if err := encoded.Close(); err != nil {
			t.Errorf("%s: close: %v", name, err)
		}
	}
}

// TestEncodeBodyFallsBackWhenCompressionWouldGrow covers incompressible bytes
// that still land on the text path: storing them verbatim is smaller.
func TestEncodeBodyFallsBackWhenCompressionWouldGrow(t *testing.T) {
	// A tiny body: the zstd frame header alone exceeds it.
	body := []byte("hi")
	encoded, err := EncodeBody("tiny.out", body)
	if err != nil {
		t.Fatalf("EncodeBody: %v", err)
	}
	defer func() {
		if err := encoded.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	}()
	if encoded.Encoding != EncodingIdentity {
		t.Fatalf("encoding = %q, want identity for a body compression would grow", encoded.Encoding)
	}
	if encoded.Size != int64(len(body)) {
		t.Fatalf("Size = %d, want %d", encoded.Size, len(body))
	}
}

func TestEncodingValidRejectsUnknown(t *testing.T) {
	if !EncodingIdentity.Valid() || !EncodingZstd.Valid() {
		t.Fatal("known encodings must validate")
	}
	if Encoding("brotli").Valid() {
		t.Fatal("an unknown encoding must not validate — readers must fail loudly, not guess")
	}
	if Encoding("").Valid() {
		t.Fatal("the empty encoding is not a wire value; absence is handled by the reader")
	}
}

// TestDecompressRejectsCorruptFrame proves a damaged blob surfaces an error
// instead of silently yielding a truncated body.
func TestDecompressRejectsCorruptFrame(t *testing.T) {
	var enc bytes.Buffer
	if _, err := Compress(&enc, bytes.NewReader(bytes.Repeat([]byte("ORCA TERMINATED NORMALLY\n"), 5000))); err != nil {
		t.Fatalf("Compress: %v", err)
	}
	corrupt := enc.Bytes()[: enc.Len()-8 : enc.Len()-8]
	var back bytes.Buffer
	if _, err := Decompress(&back, bytes.NewReader(corrupt)); err == nil {
		t.Fatal("truncated frame decoded without error")
	}
}
