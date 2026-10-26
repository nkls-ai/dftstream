package tracker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
)

// convexMock is a minimal stand-in for a Convex backend + file storage. It
// dispatches /api/mutation calls by their function path and serves a fake
// upload endpoint, recording what it saw so tests can assert on it.
type convexMock struct {
	t *testing.T

	mu sync.Mutex
	// setAllItems is the items array seen by the last artifacts:setAll call.
	setAllItems []map[string]any
	// deletedBlobs collects storageIds passed to artifacts:deleteBlob.
	deletedBlobs []string
	// uploadHits counts POSTs to the fake upload URL.
	uploadHits int
	// uploadedBodies / uploadedTypes record the bytes and Content-Type of
	// every successful POST to the fake upload URL, so tests can assert the
	// blob that actually crossed the wire (encoded, if compression applied).
	uploadedBodies [][]byte
	uploadedTypes  []string
	// freqArgs is the full args map of the last frequencies:setAll call.
	freqArgs map[string]any

	// knobs
	setAllStatus      string // "success" (default) or "error"
	uploadFail        int    // return 429 for the first N upload attempts
	storageID         string // storageId handed back by the upload endpoint
	uploadURLOverride string // when set, generateUploadUrl returns this verbatim
}

func newConvexMock(t *testing.T) (*convexMock, *httptest.Server) {
	m := &convexMock{t: t, setAllStatus: "success", storageID: "blob_abc"}
	srv := httptest.NewServer(m)
	return m, srv
}

func (m *convexMock) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)

	if strings.HasSuffix(r.URL.Path, "/upload") {
		m.mu.Lock()
		m.uploadHits++
		fail := m.uploadHits <= m.uploadFail
		m.mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte("slow down"))
			return
		}
		m.mu.Lock()
		m.uploadedBodies = append(m.uploadedBodies, body)
		m.uploadedTypes = append(m.uploadedTypes, r.Header.Get("Content-Type"))
		m.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"storageId":"` + m.storageID + `"}`))
		return
	}

	// Otherwise it's an /api/mutation envelope call; dispatch on path.
	var req convexRequest
	if err := json.Unmarshal(body, &req); err != nil {
		m.t.Fatalf("mock: bad request body: %v", err)
	}

	writeEnvelope := func(value any) {
		raw, _ := json.Marshal(value)
		out, _ := json.Marshal(convexEnvelope{Status: "success", Value: raw})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	}

	switch req.Path {
	case "artifacts:generateUploadUrl":
		if m.uploadURLOverride != "" {
			writeEnvelope(m.uploadURLOverride)
			return
		}
		// Point the client at this same server's /upload route.
		writeEnvelope("http://" + r.Host + "/upload")
	case "artifacts:setAll", "artifacts:appendToRun":
		m.mu.Lock()
		if items, ok := req.Args["items"].([]any); ok {
			m.setAllItems = nil
			for _, it := range items {
				if obj, ok := it.(map[string]any); ok {
					m.setAllItems = append(m.setAllItems, obj)
				}
			}
		}
		status := m.setAllStatus
		n := len(m.setAllItems)
		m.mu.Unlock()
		if status != "success" {
			out, _ := json.Marshal(convexEnvelope{Status: "error", ErrorMessage: "boom"})
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(out)
			return
		}
		ids := make([]string, n)
		for i := range ids {
			ids[i] = "art_" + string(rune('a'+i))
		}
		writeEnvelope(ids)
	case "frequencies:setAll":
		m.mu.Lock()
		m.freqArgs = req.Args
		m.mu.Unlock()
		writeEnvelope(nil)
	case "artifacts:deleteBlob":
		m.mu.Lock()
		if id, ok := req.Args["storageId"].(string); ok {
			m.deletedBlobs = append(m.deletedBlobs, id)
		}
		m.mu.Unlock()
		writeEnvelope(nil)
	default:
		m.t.Fatalf("mock: unexpected mutation path %q", req.Path)
	}
}

func newTestTracker(base string) *ConvexHTTPTracker {
	c := NewConvexHTTPTracker(base)
	c.maxRetries = 2 // keep retry-driven tests fast
	return c
}

func TestSetFrequenciesSendsHessIdx(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	c := newTestTracker(srv.URL)

	err := c.SetFrequencies(context.Background(), "run1", []Frequency{
		{Idx: 6, Wavenumber: -100, Imaginary: true, HessIdx: 2},
	})
	if err != nil {
		t.Fatalf("SetFrequencies: %v", err)
	}
	m.mu.Lock()
	got, ok := m.freqArgs["hessIdx"].(float64)
	m.mu.Unlock()
	if !ok || got != 2 {
		t.Errorf("hessIdx arg = %v, want 2", m.freqArgs["hessIdx"])
	}
}

func TestSetFrequenciesOmitsZeroHessIdx(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	c := newTestTracker(srv.URL)

	err := c.SetFrequencies(context.Background(), "run1", []Frequency{
		{Idx: 0, Wavenumber: 1600},
	})
	if err != nil {
		t.Fatalf("SetFrequencies: %v", err)
	}
	m.mu.Lock()
	_, present := m.freqArgs["hessIdx"]
	m.mu.Unlock()
	if present {
		t.Errorf("hessIdx must be absent for legacy (0) events, got %v", m.freqArgs["hessIdx"])
	}
}

func bigBody(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'x'
	}
	return b
}

func TestSetArtifactsUploadsBodyAndRecordsStorageID(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	c := newTestTracker(srv.URL)

	items := []Artifact{{
		Name:        "big.out",
		Path:        "/host/big.out",
		Kind:        "output",
		SizeBytes:   100000,
		MTime:       time.Unix(1, 0),
		ContentText: "preview",
		Body:        bigBody(100000),
	}}
	if err := c.SetArtifacts(context.Background(), "run1", items); err != nil {
		t.Fatalf("SetArtifacts: %v", err)
	}

	if m.uploadHits != 1 {
		t.Fatalf("upload hits = %d, want 1", m.uploadHits)
	}
	if len(m.setAllItems) != 1 {
		t.Fatalf("setAll items = %d, want 1", len(m.setAllItems))
	}
	if got := m.setAllItems[0]["storageId"]; got != "blob_abc" {
		t.Fatalf("setAll item storageId = %v, want blob_abc", got)
	}
	if len(m.deletedBlobs) != 0 {
		t.Fatalf("deletedBlobs = %v, want none on success", m.deletedBlobs)
	}
}

func TestSetArtifactsSkipsUploadForSmallInlineBody(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	c := newTestTracker(srv.URL)

	items := []Artifact{{
		Name:        "small.inp",
		Path:        "/host/small.inp",
		Kind:        "input",
		SizeBytes:   5,
		MTime:       time.Unix(1, 0),
		ContentText: "hello",
		// Body nil — whole file fit in the inline preview.
	}}
	if err := c.SetArtifacts(context.Background(), "run1", items); err != nil {
		t.Fatalf("SetArtifacts: %v", err)
	}
	if m.uploadHits != 0 {
		t.Fatalf("upload hits = %d, want 0 (no body)", m.uploadHits)
	}
	if _, ok := m.setAllItems[0]["storageId"]; ok {
		t.Fatal("inline-only artifact should carry no storageId")
	}
}

func TestSetArtifactsDeletesOrphanBlobOnMutationFailure(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	m.setAllStatus = "error" // the follow-up write fails after the blob uploaded
	c := newTestTracker(srv.URL)

	items := []Artifact{{
		Name:      "big.out",
		Path:      "/host/big.out",
		Kind:      "output",
		SizeBytes: 100000,
		MTime:     time.Unix(1, 0),
		Body:      bigBody(100000),
	}}
	err := c.SetArtifacts(context.Background(), "run1", items)
	if err == nil {
		t.Fatal("SetArtifacts: expected error from failing setAll")
	}
	if m.uploadHits != 1 {
		t.Fatalf("upload hits = %d, want 1", m.uploadHits)
	}
	// The uploaded blob is orphaned (no row references it) and must be deleted.
	if len(m.deletedBlobs) != 1 || m.deletedBlobs[0] != "blob_abc" {
		t.Fatalf("deletedBlobs = %v, want [blob_abc]", m.deletedBlobs)
	}
}

func TestRewriteToBaseHostRepointsLocalhostURL(t *testing.T) {
	c := NewConvexHTTPTracker("http://backend.example.org:16767")
	// generateUploadUrl on a self-hosted backend hands back its own origin.
	raw := "http://127.0.0.1:16767/api/storage/upload?token=abc123"
	got := c.rewriteToBaseHost(raw)
	want := "http://backend.example.org:16767/api/storage/upload?token=abc123"
	if got != want {
		t.Fatalf("rewriteToBaseHost = %q, want %q", got, want)
	}
}

func TestUploadUsesRewrittenHost(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	// Make the upload URL the mock returns point at an unreachable host; the
	// client must rewrite it back to the base it actually dialed (srv.URL).
	m.uploadURLOverride = "http://127.0.0.1:1/api/storage/upload?token=zzz"
	c := newTestTracker(srv.URL)

	raw := bigBody(1000)
	id, err := c.uploadBlob(context.Background(), bytes.NewReader(raw), int64(len(raw)), artifacts.EncodingIdentity)
	if err != nil {
		t.Fatalf("uploadBlob: %v", err)
	}
	if id != "blob_abc" {
		t.Fatalf("storageId = %q, want blob_abc", id)
	}
	if m.uploadHits != 1 {
		t.Fatalf("upload hits = %d, want 1 (rewritten to reachable host)", m.uploadHits)
	}
}

func TestUploadBlobRetriesOn429(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	m.uploadFail = 1 // first upload attempt is throttled, second succeeds
	c := newTestTracker(srv.URL)

	raw := bigBody(1000)
	id, err := c.uploadBlob(context.Background(), bytes.NewReader(raw), int64(len(raw)), artifacts.EncodingIdentity)
	if err != nil {
		t.Fatalf("uploadBlob: %v", err)
	}
	if id != "blob_abc" {
		t.Fatalf("storageId = %q, want blob_abc", id)
	}
	if m.uploadHits != 2 {
		t.Fatalf("upload hits = %d, want 2 (1 throttled + 1 success)", m.uploadHits)
	}
}

func TestBuildArtifactPayloadReportsUploadedBlobs(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	c := newTestTracker(srv.URL)

	items := []Artifact{
		{Name: "a.out", Kind: "output", SizeBytes: 50000, MTime: time.Unix(1, 0), Body: bigBody(50000)},
		{Name: "b.inp", Kind: "input", SizeBytes: 3, MTime: time.Unix(1, 0), ContentText: "abc"},
	}
	out, uploaded, err := c.buildArtifactPayload(context.Background(), items)
	if err != nil {
		t.Fatalf("buildArtifactPayload: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("payload len = %d, want 2", len(out))
	}
	if len(uploaded) != 1 || uploaded[0] != "blob_abc" {
		t.Fatalf("uploaded = %v, want [blob_abc]", uploaded)
	}
	if _, ok := out[1]["storageId"]; ok {
		t.Fatal("inline item should not have storageId")
	}
	if m.uploadHits != 1 {
		t.Fatalf("upload hits = %d, want 1", m.uploadHits)
	}
}

// realisticBody returns n bytes of ORCA-ish repetitive text, which (unlike
// bigBody's run of 'x') exercises the compressor on data with real structure.
func realisticBody(n int) []byte {
	var b bytes.Buffer
	for i := 0; b.Len() < n; i++ {
		fmt.Fprintf(&b, "ITER %6d   E= %-20.10f  DE= %-14.3e  RMSDP= %-12.3e\n",
			i, -76.0261234567+float64(i)*1e-7, 1e-6, 3e-7)
	}
	return b.Bytes()[:n]
}

func TestSetArtifactsCompressesTextBodyAndRoundTrips(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	c := newTestTracker(srv.URL)

	raw := realisticBody(400000)
	items := []Artifact{{
		Name:        "big.out",
		Path:        "/host/big.out",
		Kind:        "output",
		SizeBytes:   int64(len(raw)),
		MTime:       time.Unix(1, 0),
		ContentText: "PREVIEW HEAD",
		Body:        raw,
	}}
	if err := c.SetArtifacts(context.Background(), "run1", items); err != nil {
		t.Fatalf("SetArtifacts: %v", err)
	}

	item := m.setAllItems[0]
	if got := item["encoding"]; got != string(artifacts.EncodingZstd) {
		t.Fatalf("encoding = %v, want %q", got, artifacts.EncodingZstd)
	}
	// The inline preview must stay plain text — search and the instant
	// preview never pay a decode.
	if got := item["contentText"]; got != "PREVIEW HEAD" {
		t.Fatalf("contentText = %v, want the plain preview", got)
	}
	// sizeBytes keeps meaning "size of the chemist's file"; storageBytes is
	// what the blob actually costs.
	if got := item["sizeBytes"]; got != float64(len(raw)) {
		t.Fatalf("sizeBytes = %v, want %d (the raw size)", got, len(raw))
	}
	stored, ok := item["storageBytes"].(float64)
	if !ok || int(stored) >= len(raw) {
		t.Fatalf("storageBytes = %v, want a positive number below %d", item["storageBytes"], len(raw))
	}

	if len(m.uploadedBodies) != 1 {
		t.Fatalf("uploaded bodies = %d, want 1", len(m.uploadedBodies))
	}
	if got := m.uploadedTypes[0]; got != "application/zstd" {
		t.Fatalf("upload Content-Type = %q, want application/zstd", got)
	}
	if int64(len(m.uploadedBodies[0])) != int64(stored) {
		t.Fatalf("uploaded %d bytes but recorded storageBytes=%v", len(m.uploadedBodies[0]), stored)
	}
	var back bytes.Buffer
	if _, err := artifacts.Decompress(&back, bytes.NewReader(m.uploadedBodies[0])); err != nil {
		t.Fatalf("decompress uploaded blob: %v", err)
	}
	if !bytes.Equal(back.Bytes(), raw) {
		t.Fatal("round-tripped blob does not match the original body")
	}
}

func TestSetArtifactsKeepsAlreadyCompressedBodyIdentity(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	c := newTestTracker(srv.URL)

	raw := bigBody(100000)
	items := []Artifact{{
		Name:      "plot.png",
		Kind:      "other",
		SizeBytes: int64(len(raw)),
		MTime:     time.Unix(1, 0),
		Body:      raw,
	}}
	if err := c.SetArtifacts(context.Background(), "run1", items); err != nil {
		t.Fatalf("SetArtifacts: %v", err)
	}
	if got := m.setAllItems[0]["encoding"]; got != string(artifacts.EncodingIdentity) {
		t.Fatalf("encoding = %v, want %q", got, artifacts.EncodingIdentity)
	}
	if got := m.uploadedTypes[0]; got != "text/plain" {
		t.Fatalf("upload Content-Type = %q, want text/plain", got)
	}
	if !bytes.Equal(m.uploadedBodies[0], raw) {
		t.Fatal("identity body must cross the wire verbatim")
	}
}

func TestUploadBlobRetryReplaysTheSameBytes(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	m.uploadFail = 1
	c := newTestTracker(srv.URL)

	raw := realisticBody(64000)
	items := []Artifact{{
		Name: "retry.out", Kind: "output", SizeBytes: int64(len(raw)),
		MTime: time.Unix(1, 0), Body: raw,
	}}
	if err := c.SetArtifacts(context.Background(), "run1", items); err != nil {
		t.Fatalf("SetArtifacts: %v", err)
	}
	if len(m.uploadedBodies) != 1 {
		t.Fatalf("successful uploads = %d, want 1", len(m.uploadedBodies))
	}
	var back bytes.Buffer
	if _, err := artifacts.Decompress(&back, bytes.NewReader(m.uploadedBodies[0])); err != nil {
		t.Fatalf("decompress retried blob: %v", err)
	}
	if !bytes.Equal(back.Bytes(), raw) {
		t.Fatal("retried upload did not replay the full encoded body")
	}
}

// A body past SpillToDiskBytes is staged in a temp file. net/http closes a
// request body that is an io.Closer, so handing it the *os.File directly made
// every retry fail to rewind and the final Close warn "file already closed".
func TestUploadBlobRetryWorksForDiskStagedBody(t *testing.T) {
	m, srv := newConvexMock(t)
	defer srv.Close()
	m.uploadFail = 1
	c := newTestTracker(srv.URL)
	var warnings bytes.Buffer
	c.SetWarnWriter(&warnings)

	raw := realisticBody(artifacts.SpillToDiskBytes + 1<<20)
	items := []Artifact{{
		Name: "big.out", Kind: "output", SizeBytes: int64(len(raw)),
		MTime: time.Unix(1, 0), Body: raw,
	}}
	if err := c.SetArtifacts(context.Background(), "run1", items); err != nil {
		t.Fatalf("SetArtifacts: %v", err)
	}
	if warnings.Len() != 0 {
		t.Fatalf("unexpected warnings: %s", warnings.String())
	}
	if len(m.uploadedBodies) != 1 {
		t.Fatalf("successful uploads = %d, want 1", len(m.uploadedBodies))
	}
	var back bytes.Buffer
	if _, err := artifacts.Decompress(&back, bytes.NewReader(m.uploadedBodies[0])); err != nil {
		t.Fatalf("decompress retried blob: %v", err)
	}
	if !bytes.Equal(back.Bytes(), raw) {
		t.Fatal("retried disk-staged upload did not replay the full encoded body")
	}
}
