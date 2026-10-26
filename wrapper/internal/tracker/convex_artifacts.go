package tracker

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/stringutil"
	"github.com/nkls-ai/dftstream/internal/version"
)

// uploadBlob stores a full artifact body in Convex file storage and
// returns the resulting _storage id. It first asks the backend for a
// short-lived upload URL, then POSTs the body to it. This path is not
// bound by the per-second document write quota, so a large body that
// would otherwise need dozens of chunk writes uploads in one request.
//
// body is a ReadSeeker rather than a []byte so an already-encoded body can be
// streamed straight off its staging buffer or temp file; each retry rewinds it
// instead of holding a second copy in memory.
// uploadAttemptBody returns the reader for one upload attempt. net/http closes
// a request body that implements io.Closer — for a disk-staged body that is
// the staging *os.File, which would make every retry fail to rewind and the
// owner's later Close report "file already closed". The transport may also
// still be draining a failed attempt's body after Do returns, so attempts must
// not share a read offset. A fresh SectionReader per attempt (no Close method)
// solves both; the plain rewind is only a fallback for readers without ReadAt.
func uploadAttemptBody(body io.ReadSeeker, size int64) (io.Reader, error) {
	if ra, ok := body.(io.ReaderAt); ok {
		return io.NewSectionReader(ra, 0, size), nil
	}
	if _, err := body.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("uploadBlob: rewind body: %w", err)
	}
	return io.NopCloser(body), nil
}

func (c *ConvexHTTPTracker) uploadBlob(ctx context.Context, body io.ReadSeeker, size int64, enc artifacts.Encoding) (string, error) {
	raw, err := c.mutation(ctx, fnArtifactsGenerateUploadURL, map[string]any{})
	if err != nil {
		return "", err
	}
	var uploadURL string
	if err := json.Unmarshal(raw, &uploadURL); err != nil {
		return "", fmt.Errorf("uploadBlob: decode upload url: %w", err)
	}
	uploadURL = c.rewriteToBaseHost(uploadURL)

	var lastErr error
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		if err := c.sleepBackoff(ctx, attempt); err != nil {
			return "", err
		}
		attemptBody, err := uploadAttemptBody(body, size)
		if err != nil {
			return "", err
		}
		req, err := http.NewRequestWithContext(ctx, "POST", uploadURL, attemptBody)
		if err != nil {
			return "", err
		}
		req.ContentLength = size
		req.Header.Set("Content-Type", enc.ContentType())
		req.Header.Set("User-Agent", version.UserAgent())
		resp, err := c.hc.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		buf, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("uploadBlob: read response body: %w", readErr)
			continue
		}
		if resp.StatusCode == 429 || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("uploadBlob: upload returned HTTP %d: %s", resp.StatusCode, stringutil.Truncate(buf, 200))
			continue
		}
		if resp.StatusCode >= 400 {
			return "", fmt.Errorf("uploadBlob: upload returned HTTP %d: %s", resp.StatusCode, stringutil.Truncate(buf, 200))
		}
		var decoded struct {
			StorageID string `json:"storageId"`
		}
		if err := json.Unmarshal(buf, &decoded); err != nil {
			return "", fmt.Errorf("uploadBlob: decode storageId: %w (body=%q)", err, stringutil.Truncate(buf, 200))
		}
		if decoded.StorageID == "" {
			return "", fmt.Errorf("uploadBlob: empty storageId in response %q", stringutil.Truncate(buf, 200))
		}
		return decoded.StorageID, nil
	}
	return "", fmt.Errorf("uploadBlob: upload failed after %d attempt(s): %w", c.maxRetries+1, lastErr)
}

// rewriteToBaseHost repoints a server-issued storage URL back at the host the
// client actually dialed. A self-hosted Convex backend builds the upload URL
// from its own configured origin (typically http://127.0.0.1:PORT), which a
// remote client cannot reach. The storage endpoint lives on the same backend
// we already talk to, so swap in c.base's scheme+host and keep the path and
// token query intact. On any parse failure the original URL is returned
// unchanged.
func (c *ConvexHTTPTracker) rewriteToBaseHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	b, err := url.Parse(c.base)
	if err != nil {
		return raw
	}
	u.Scheme = b.Scheme
	u.Host = b.Host
	return u.String()
}

// buildArtifactPayload converts artifacts to the wire shape for setAll /
// appendToRun, uploading any over-preview bodies to file storage first and
// recording the resulting storageId on each item. It also returns the list of
// storageIds it created so the caller can delete them if the follow-up
// setAll/appendToRun mutation fails — until a row references them they are
// orphaned blobs that would otherwise leak.
func (c *ConvexHTTPTracker) buildArtifactPayload(ctx context.Context, items []Artifact) ([]map[string]any, []string, error) {
	out := make([]map[string]any, len(items))
	var uploaded []string
	for i, a := range items {
		obj := map[string]any{
			"name":      a.Name,
			"path":      a.Path,
			"kind":      a.Kind,
			"sizeBytes": a.SizeBytes,
			"mtime":     a.MTime.UnixMilli(),
		}
		if a.ContentText != "" {
			obj["contentText"] = a.ContentText
		}
		if a.Truncated {
			obj["truncated"] = true
		}
		if len(a.Body) > 0 {
			// EncodeBody always hands back a usable body; a non-nil error only
			// says compression was skipped, so we log it and upload identity
			// rather than lose the artifact.
			encoded, encErr := artifacts.EncodeBody(a.Name, a.Body)
			if encErr != nil {
				c.warnf("storing %q uncompressed: %v", a.Name, encErr)
			}
			storageID, err := c.uploadBlob(ctx, encoded.Reader, encoded.Size, encoded.Encoding)
			if closeErr := encoded.Close(); closeErr != nil {
				c.warnf("failed to release upload staging for %q: %v", a.Name, closeErr)
			}
			if err != nil {
				// Clean up any blobs already uploaded in this batch before bailing.
				c.deleteBlobs(ctx, uploaded)
				return nil, nil, fmt.Errorf("upload body for %q: %w", a.Name, err)
			}
			obj["storageId"] = storageID
			// Always explicit — a reader must never have to guess how the blob
			// was encoded. (An absent field means "written before compression
			// existed", which is identity; see artifacts.Encoding.)
			obj["encoding"] = encoded.Encoding.String()
			obj["storageBytes"] = encoded.Size
			uploaded = append(uploaded, storageID)
		}
		out[i] = obj
	}
	return out, uploaded, nil
}

// deleteBlobs best-effort removes orphaned storage blobs. Failures are logged
// but not returned — the caller is already on an error path and a leaked blob
// is less bad than masking the original failure.
func (c *ConvexHTTPTracker) deleteBlobs(ctx context.Context, storageIDs []string) {
	for _, id := range storageIDs {
		if _, err := c.mutation(ctx, fnArtifactsDeleteBlob, map[string]any{"storageId": id}); err != nil {
			c.warnf("failed to delete orphaned storage blob %s: %v", id, err)
		}
	}
}

func (c *ConvexHTTPTracker) SetArtifacts(ctx context.Context, runID RunID, items []Artifact) error {
	return c.writeArtifacts(ctx, fnArtifactsSetAll, "SetArtifacts", runID, items)
}

func (c *ConvexHTTPTracker) AppendArtifacts(ctx context.Context, runID RunID, items []Artifact) error {
	return c.writeArtifacts(ctx, fnArtifactsAppendToRun, "AppendArtifacts", runID, items)
}

func (c *ConvexHTTPTracker) UpsertArtifacts(ctx context.Context, runID RunID, items []Artifact) error {
	return c.writeArtifacts(ctx, fnArtifactsUpsertForRun, "UpsertArtifacts", runID, items)
}

// writeArtifacts uploads any over-preview bodies, then writes the manifest
// rows through fn (setAll / appendToRun / upsertForRun). op names the
// public method in error messages. On any failure after the uploads, the
// freshly stored blobs are deleted — no row references them yet, so they
// would otherwise leak.
func (c *ConvexHTTPTracker) writeArtifacts(ctx context.Context, fn, op string, runID RunID, items []Artifact) error {
	out, uploaded, err := c.buildArtifactPayload(ctx, items)
	if err != nil {
		return fmt.Errorf("%s: %w", op, err)
	}
	raw, err := c.mutation(ctx, fn, map[string]any{
		"runId": runID, "items": out,
	})
	if err != nil {
		c.deleteBlobs(ctx, uploaded)
		return err
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		c.deleteBlobs(ctx, uploaded)
		return fmt.Errorf("%s: decode ids: %w", op, err)
	}
	if len(ids) != len(items) {
		c.deleteBlobs(ctx, uploaded)
		return fmt.Errorf("%s: backend returned %d ids for %d items", op, len(ids), len(items))
	}
	return nil
}
