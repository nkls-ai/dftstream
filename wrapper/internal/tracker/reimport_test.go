package tracker

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/nkls-ai/dftstream/internal/artifacts"
)

// Convex's JSON format writes every number with a decimal point; the
// handshake must decode "1.0" (what a real deployment sends), not just "1"
// (what Go-marshaled test doubles send).
func TestBackendVersionDecodesConvexFloats(t *testing.T) {
	for _, raw := range []string{
		`{"apiVersion":1.0,"minWrapperApiVersion":0.0,"features":["organizations"]}`,
		`{"apiVersion":1,"minWrapperApiVersion":0,"features":["organizations"]}`,
	} {
		var bv BackendVersion
		if err := json.Unmarshal([]byte(raw), &bv); err != nil {
			t.Fatalf("decode %s: %v", raw, err)
		}
		if bv.APIVersion != 1 || bv.MinWrapperAPIVersion != 0 {
			t.Errorf("decoded %s to %+v, want apiVersion=1 minWrapper=0", raw, bv)
		}
		if !bv.HasFeature("organizations") {
			t.Errorf("features lost decoding %s", raw)
		}
	}
}

func TestFetchArtifactBodyInline(t *testing.T) {
	c := NewConvexHTTPTracker("http://127.0.0.1:0")
	text := "ORCA TERMINATED NORMALLY"
	got, err := c.FetchArtifactBody(context.Background(), &ArtifactContent{ContentText: &text})
	if err != nil {
		t.Fatalf("FetchArtifactBody: %v", err)
	}
	if got != text {
		t.Errorf("got %q, want %q", got, text)
	}
}

func TestFetchArtifactBodyRejectsEmptyAndUnknownEncoding(t *testing.T) {
	c := NewConvexHTTPTracker("http://127.0.0.1:0")
	if _, err := c.FetchArtifactBody(context.Background(), nil); err == nil {
		t.Error("nil content accepted")
	}
	if _, err := c.FetchArtifactBody(context.Background(), &ArtifactContent{}); err == nil {
		t.Error("content without text or URL accepted")
	}
}

// The zstd decode path, exercised without a network: compress a body with the
// artifacts encoder and hand it back through the same decode FetchArtifactBody
// uses for storage blobs.
func TestArtifactZstdRoundTrip(t *testing.T) {
	body := []byte("FINAL SINGLE POINT ENERGY      -75.955000000000\n")
	var compressed bytes.Buffer
	if _, err := artifacts.Compress(&compressed, bytes.NewReader(body)); err != nil {
		t.Fatalf("compress: %v", err)
	}
	var out bytes.Buffer
	if _, err := artifacts.Decompress(&out, &compressed); err != nil {
		t.Fatalf("decompress: %v", err)
	}
	if out.String() != string(body) {
		t.Errorf("round trip mismatch: %q", out.String())
	}
}
