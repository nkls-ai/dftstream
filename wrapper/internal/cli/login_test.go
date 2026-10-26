package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestStartCLILinkParsesDeviceAndUserCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cli/link/start" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write([]byte(`{"deviceCode":"dev-secret","userCode":"BCDF-GHJK","verifyPath":"/cli-link?userCode=BCDF-GHJK","interval":3}`)); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	defer srv.Close()

	start, err := startCLILink(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("startCLILink: %v", err)
	}
	if start.DeviceCode != "dev-secret" || start.UserCode != "BCDF-GHJK" || start.Interval != 3 {
		t.Fatalf("unexpected start payload: %+v", start)
	}
}

func TestStartCLILinkRejectsMissingCodes(t *testing.T) {
	// A backend that still speaks the old single-code protocol must be
	// rejected, not half-parsed into an empty device code.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := w.Write([]byte(`{"code":"legacy-uuid","verifyPath":"/cli-link?code=legacy-uuid"}`)); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	defer srv.Close()

	if _, err := startCLILink(context.Background(), srv.URL); err == nil {
		t.Fatal("expected an error for a response without deviceCode/userCode")
	}
}

func TestPrintApprovalPromptNeverLeaksDeviceCode(t *testing.T) {
	t.Setenv("DFTSTREAM_UI_URL", "")
	start := linkStart{
		DeviceCode: "super-secret-device-code",
		UserCode:   "BCDF-GHJK",
		VerifyPath: "/cli-link?userCode=BCDF-GHJK",
	}

	var withURL strings.Builder
	printApprovalPrompt(&withURL, "https://ui.example", start)
	if !strings.Contains(withURL.String(), "https://ui.example/cli-link?userCode=BCDF-GHJK") {
		t.Errorf("prompt with UI URL should contain the verify link, got:\n%s", withURL.String())
	}
	var withoutURL strings.Builder
	printApprovalPrompt(&withoutURL, "", start)
	if !strings.Contains(withoutURL.String(), "BCDF-GHJK") {
		t.Errorf("prompt without UI URL should show the user code, got:\n%s", withoutURL.String())
	}
	for name, out := range map[string]string{"with url": withURL.String(), "without url": withoutURL.String()} {
		if strings.Contains(out, "super-secret-device-code") {
			t.Errorf("prompt (%s) leaked the device code:\n%s", name, out)
		}
	}
}

func TestAwaitLinkApprovalPollsWithDeviceCode(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode poll body: %v", err)
		}
		if body["deviceCode"] != "dev-secret" {
			t.Errorf("poll must send the device code, got body %v", body)
		}
		if _, ok := body["code"]; ok {
			t.Error("poll must not send the legacy `code` field")
		}
		w.Header().Set("Content-Type", "application/json")
		switch calls.Add(1) {
		case 1:
			if _, err := w.Write([]byte(`{"status":"pending"}`)); err != nil {
				t.Errorf("write: %v", err)
			}
		case 2:
			w.WriteHeader(http.StatusTooManyRequests)
			if _, err := w.Write([]byte(`{"error":"slow_down","interval":3}`)); err != nil {
				t.Errorf("write: %v", err)
			}
		default:
			if _, err := w.Write([]byte(`{"status":"approved","accessToken":"at","refreshToken":"rt","organizationId":"org1"}`)); err != nil {
				t.Errorf("write: %v", err)
			}
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	start := linkStart{DeviceCode: "dev-secret", UserCode: "BCDF-GHJK", Interval: 1}
	approval, err := awaitLinkApproval(ctx, srv.URL, start)
	if err != nil {
		t.Fatalf("awaitLinkApproval: %v", err)
	}
	if approval.AccessToken != "at" || approval.RefreshToken != "rt" || approval.OrganizationID != "org1" {
		t.Fatalf("unexpected approval: %+v", approval)
	}
	if got := calls.Load(); got < 3 {
		t.Fatalf("expected at least 3 polls (pending, slow_down, approved), got %d", got)
	}
}

func TestAwaitLinkApprovalStopsOnGone(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusGone)
		if _, err := w.Write([]byte(`{"error":"expired"}`)); err != nil {
			t.Errorf("write: %v", err)
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := linkStart{DeviceCode: "dev-secret", Interval: 1}
	if _, err := awaitLinkApproval(ctx, srv.URL, start); err == nil {
		t.Fatal("expected a terminal error for HTTP 410")
	}
}

// Regression: a deployment without JWT_PRIVATE_KEY (backend 503) and a
// wrong site origin (404) were both told to "check the tracker URL".
func TestStartFailureFixNamesWhoCanFixIt(t *testing.T) {
	misconfigured := startFailureFix(http.StatusServiceUnavailable, []byte(`{"error":"CLI token signing is not configured"}`), "http://h:3211")
	if !strings.Contains(misconfigured, "operator") {
		t.Errorf("503 fix = %q, want the operator named", misconfigured)
	}
	notFound := startFailureFix(http.StatusNotFound, nil, "http://h:3210")
	if !strings.Contains(notFound, "DFTSTREAM_CONVEX_SITE_URL") || !strings.Contains(notFound, "http://h:3210") {
		t.Errorf("404 fix = %q, want the site override named", notFound)
	}
	// A 503 from a proxy (no JSON error) stays a reachability problem.
	if got := startFailureFix(http.StatusServiceUnavailable, []byte("<html>"), "x"); !strings.Contains(got, "reachable") {
		t.Errorf("proxy 503 fix = %q", got)
	}
}
