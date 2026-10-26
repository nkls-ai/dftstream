package tracker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/stringutil"
	"github.com/nkls-ai/dftstream/internal/version"
)

// Client side of `dftstream reimport` (db/convex/reimport.ts). These live on
// ConvexHTTPTracker directly — reimport is a synchronous sweep, so it uses the
// raw tracker (retry ladder, 401 refresh) without the batching wrapper.

const (
	fnExperimentsList     = "experiments:list"
	fnReimportListRuns    = "reimport:listRuns"
	fnReimportFindOutput  = "reimport:findOutput"
	fnReimportApply       = "reimport:apply"
	fnArtifactsGetContent = "artifacts:getContent"
)

// UnmarshalJSON decodes meta:version leniently: Convex has a single number
// type and its JSON format writes integers as "1.0", which Go's int decode
// rejects — before this, the startup handshake ALWAYS degraded to "could not
// verify backend version" against a real deployment (only test doubles, which
// marshal Go ints, ever decoded). Fractions cannot occur (the backend exports
// integer constants), so the truncation is exact.
func (b *BackendVersion) UnmarshalJSON(data []byte) error {
	var raw struct {
		APIVersion           float64  `json:"apiVersion"`
		MinWrapperAPIVersion float64  `json:"minWrapperApiVersion"`
		Features             []string `json:"features"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	b.APIVersion = int(raw.APIVersion)
	b.MinWrapperAPIVersion = int(raw.MinWrapperAPIVersion)
	b.Features = raw.Features
	return nil
}

// ExperimentRef identifies one experiment (the reimport sweep, `dftstream
// list`).
type ExperimentRef struct {
	ID   string `json:"_id"`
	Name string `json:"name"`
	// CreatedAt is the creation time in Unix milliseconds.
	CreatedAt float64 `json:"createdAt"`
}

// ListExperiments returns the deployment's experiments (org-scoped when orgID
// is set; required on deployments that enforce auth).
func (c *ConvexHTTPTracker) ListExperiments(ctx context.Context, orgID string) ([]ExperimentRef, error) {
	args := map[string]any{}
	orgID, err := c.resolveOrg(ctx, orgID)
	if err != nil {
		return nil, err
	}
	if orgID != "" {
		args["organizationId"] = orgID
	}
	raw, err := c.query(ctx, fnExperimentsList, args)
	if err != nil {
		return nil, err
	}
	var out []ExperimentRef
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("ListExperiments: decode: %w", err)
	}
	return out, nil
}

// ReimportRunsPage is one page of reimport:listRuns. Rows stay raw JSON so
// the tracker does not depend on the reimport package (which depends on this
// one); the caller decodes them into reimport.Run.
type ReimportRunsPage struct {
	Page           []json.RawMessage `json:"page"`
	IsDone         bool              `json:"isDone"`
	ContinueCursor string            `json:"continueCursor"`
}

// ListReimportRuns fetches one page of an experiment's runs in the stable
// (startedAt ascending) reimport order. cursor is "" for the first page.
func (c *ConvexHTTPTracker) ListReimportRuns(ctx context.Context, experimentID, cursor string, numItems int) (ReimportRunsPage, error) {
	opts := map[string]any{"numItems": numItems}
	if cursor == "" {
		opts["cursor"] = nil
	} else {
		opts["cursor"] = cursor
	}
	raw, err := c.query(ctx, fnReimportListRuns, map[string]any{
		"experimentId":   experimentID,
		"paginationOpts": opts,
	})
	if err != nil {
		return ReimportRunsPage{}, err
	}
	var page ReimportRunsPage
	if err := json.Unmarshal(raw, &page); err != nil {
		return ReimportRunsPage{}, fmt.Errorf("ListReimportRuns: decode: %w", err)
	}
	return page, nil
}

// ReimportOutputRef names the artifact carrying a run's ORCA output text.
type ReimportOutputRef struct {
	ArtifactID string  `json:"artifactId"`
	Name       string  `json:"name"`
	Path       string  `json:"path"`
	Kind       string  `json:"kind"`
	SizeBytes  float64 `json:"sizeBytes"`
	Truncated  bool    `json:"truncated"`
}

// FindReimportOutput resolves the run's output artifact, or nil when the run
// has none stored (the caller then falls back to the local file).
func (c *ConvexHTTPTracker) FindReimportOutput(ctx context.Context, runID string) (*ReimportOutputRef, error) {
	raw, err := c.query(ctx, fnReimportFindOutput, map[string]any{"runId": runID})
	if err != nil {
		return nil, err
	}
	if string(raw) == "null" {
		return nil, nil
	}
	var ref ReimportOutputRef
	if err := json.Unmarshal(raw, &ref); err != nil {
		return nil, fmt.Errorf("FindReimportOutput: decode: %w", err)
	}
	return &ref, nil
}

// ArtifactContent is artifacts:getContent's answer: either an inline body or
// a URL to download the blob from, plus how that blob is encoded. Two URL
// shapes exist across backend versions: `bodyUrl` (current — an authenticated
// HTTP action on the deployment's site origin, fetched with the caller's own
// bearer) and `url` (older backends — a signed storage URL on the deployment
// origin). The client accepts both so one wrapper serves the N/N-1 window.
type ArtifactContent struct {
	ContentText *string `json:"contentText"`
	BodyURL     *string `json:"bodyUrl"`
	URL         *string `json:"url"`
	Encoding    *string `json:"encoding"`
	Truncated   bool    `json:"truncated"`
	Incomplete  bool    `json:"incomplete"`
}

// GetArtifactContent fetches the content descriptor for one artifact, or nil
// when the artifact row no longer exists.
func (c *ConvexHTTPTracker) GetArtifactContent(ctx context.Context, artifactID string) (*ArtifactContent, error) {
	raw, err := c.query(ctx, fnArtifactsGetContent, map[string]any{"artifactId": artifactID})
	if err != nil {
		return nil, err
	}
	if string(raw) == "null" {
		return nil, nil
	}
	var content ArtifactContent
	if err := json.Unmarshal(raw, &content); err != nil {
		return nil, fmt.Errorf("GetArtifactContent: decode: %w", err)
	}
	return &content, nil
}

// FetchArtifactBody turns an ArtifactContent into the plain output text:
// inline bodies come back as-is, storage-backed ones are downloaded (with the
// same host rewrite the uploader needs for self-hosted backends) and decoded
// per the row's declared encoding — never by sniffing the bytes.
func (c *ConvexHTTPTracker) FetchArtifactBody(ctx context.Context, content *ArtifactContent) (string, error) {
	if content == nil {
		return "", fmt.Errorf("FetchArtifactBody: artifact has no content")
	}
	var downloadURL string
	switch {
	case content.ContentText != nil:
		return *content.ContentText, nil
	case content.BodyURL != nil:
		// The authenticated /api/artifact HTTP action. Its origin is the
		// deployment's own CONVEX_SITE_URL — used verbatim, since unlike the
		// legacy storage URLs it is not derived from the origin we dialed.
		downloadURL = *content.BodyURL
	case content.URL != nil:
		// Legacy signed storage URL from an older backend: repoint it at the
		// host we actually dialed (self-hosted backends mint loopback URLs).
		downloadURL = c.rewriteToBaseHost(*content.URL)
	default:
		return "", fmt.Errorf("FetchArtifactBody: artifact has neither inline text nor a download URL")
	}
	body, err := c.downloadBlob(ctx, downloadURL)
	if err != nil {
		return "", err
	}
	enc := artifacts.EncodingIdentity
	if content.Encoding != nil && *content.Encoding != "" {
		enc = artifacts.Encoding(*content.Encoding)
	}
	switch enc {
	case artifacts.EncodingIdentity:
		return string(body), nil
	case artifacts.EncodingZstd:
		var out bytes.Buffer
		if _, err := artifacts.Decompress(&out, bytes.NewReader(body)); err != nil {
			return "", fmt.Errorf("FetchArtifactBody: %w", err)
		}
		return out.String(), nil
	default:
		// A closed union server-side; an unknown value here means a newer
		// backend. Refuse rather than hand corrupt text to the parser.
		return "", fmt.Errorf("FetchArtifactBody: unknown blob encoding %q", enc)
	}
}

// downloadBlob GETs an artifact body URL with the tracker's retry ladder and
// bearer (the authenticated /api/artifact route gates every request on the
// caller's own token), including the one-shot 401 refresh call() performs.
func (c *ConvexHTTPTracker) downloadBlob(ctx context.Context, url string) ([]byte, error) {
	var lastErr error
	triedRefresh := false
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		if err := c.sleepBackoff(ctx, attempt); err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", version.UserAgent())
		tok, err := c.authorize(ctx, req)
		if err != nil {
			return nil, fmt.Errorf("downloadBlob: %w", err)
		}
		resp, err := c.hc.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		buf, readErr := io.ReadAll(resp.Body)
		if closeErr := resp.Body.Close(); closeErr != nil && readErr == nil {
			// The body was fully read; a close failure loses nothing but is
			// still recorded as the retry reason if the read succeeded oddly.
			readErr = closeErr
		}
		if readErr != nil {
			lastErr = fmt.Errorf("downloadBlob: read body: %w", readErr)
			continue
		}
		if resp.StatusCode == 401 {
			var refreshErr error
			if !triedRefresh {
				triedRefresh = true
				if refreshErr = c.refreshAfter401(ctx, tok); refreshErr == nil {
					attempt--
					continue
				}
			}
			return nil, c.unauthorizedError("downloadBlob", buf, refreshErr)
		}
		if resp.StatusCode == 429 || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("downloadBlob: HTTP %d: %s", resp.StatusCode, stringutil.Truncate(buf, 200))
			continue
		}
		if resp.StatusCode >= 400 {
			return nil, fmt.Errorf("downloadBlob: HTTP %d: %s", resp.StatusCode, stringutil.Truncate(buf, 200))
		}
		return buf, nil
	}
	return nil, fmt.Errorf("downloadBlob: failed after %d attempt(s): %w", c.maxRetries+1, lastErr)
}

// ApplyReimport calls reimport:apply for one run. patch maps field names to
// their new values; a nil value marshals as JSON null, which the backend
// interprets as "clear the stored field". reimportedWith stamps the wrapper
// build performing the sweep.
func (c *ConvexHTTPTracker) ApplyReimport(ctx context.Context, runID string, patch map[string]any, reimportedWith string) error {
	args := map[string]any{
		"runId":          runID,
		"reimportedWith": reimportedWith,
	}
	for k, v := range patch {
		args[k] = v
	}
	_, err := c.mutation(ctx, fnReimportApply, args)
	return err
}
