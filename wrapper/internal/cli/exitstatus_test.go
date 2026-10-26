package cli

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/tracker"
	"github.com/nkls-ai/dftstream/internal/version"
)

// fakeVersionTracker is a no-op tracker with a scripted handshake answer.
type fakeVersionTracker struct {
	tracker.Tracker
	bv  tracker.BackendVersion
	err error
}

func (f fakeVersionTracker) BackendVersion(context.Context) (tracker.BackendVersion, error) {
	return f.bv, f.err
}

func newFake(bv tracker.BackendVersion, err error) fakeVersionTracker {
	return fakeVersionTracker{Tracker: tracker.NewNoopTracker(), bv: bv, err: err}
}

const testDSN = "convex+http://127.0.0.1:3210"

func TestCheckBackendVersionAcceptsMatchingVersion(t *testing.T) {
	var buf bytes.Buffer
	fake := newFake(tracker.BackendVersion{
		APIVersion:           version.APIVersion,
		MinWrapperAPIVersion: version.APIVersion - 1,
	}, nil)
	if err := checkBackendVersion(context.Background(), fake, testDSN, &buf); err != nil {
		t.Fatalf("checkBackendVersion = %v, want nil", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("compatible handshake printed %q, want silence", buf.String())
	}
}

// N-1 is inside the support window: the backend explicitly says so.
func TestCheckBackendVersionAcceptsOneVersionBehind(t *testing.T) {
	var buf bytes.Buffer
	fake := newFake(tracker.BackendVersion{
		APIVersion:           version.APIVersion + 1,
		MinWrapperAPIVersion: version.APIVersion,
	}, nil)
	if err := checkBackendVersion(context.Background(), fake, testDSN, &buf); err != nil {
		t.Fatalf("checkBackendVersion = %v, want nil for N-1 wrapper", err)
	}
	if buf.Len() != 0 {
		t.Fatalf("in-window handshake printed %q, want silence", buf.String())
	}
}

func TestCheckBackendVersionRejectsStaleBackend(t *testing.T) {
	var buf bytes.Buffer
	fake := newFake(tracker.BackendVersion{
		APIVersion:           version.APIVersion - 1,
		MinWrapperAPIVersion: version.APIVersion - 2,
	}, nil)
	err := checkBackendVersion(context.Background(), fake, testDSN, &buf)
	if exitCodeFor(err) != 2 || err == nil {
		t.Fatalf("checkBackendVersion = %v (code %d), want exit 2", err, exitCodeFor(err))
	}
	out := buf.String()
	if !strings.Contains(out, "push-functions.sh http://127.0.0.1:3210") {
		t.Fatalf("stale-backend message %q does not name the push-functions fix", out)
	}
	if strings.Count(strings.TrimSpace(out), "\n") > 1 {
		t.Fatalf("stale-backend message is not one line + one fix: %q", out)
	}
}

func TestCheckBackendVersionRejectsStaleWrapper(t *testing.T) {
	var buf bytes.Buffer
	fake := newFake(tracker.BackendVersion{
		APIVersion:           version.APIVersion + 3,
		MinWrapperAPIVersion: version.APIVersion + 2,
	}, nil)
	err := checkBackendVersion(context.Background(), fake, testDSN, &buf)
	if err == nil || exitCodeFor(err) != 2 {
		t.Fatalf("checkBackendVersion = %v, want exit 2", err)
	}
	if !strings.Contains(buf.String(), "install.sh") {
		t.Fatalf("stale-wrapper message %q does not name the upgrade command", buf.String())
	}
}

// A backend too old to have meta:version at all, or one that is briefly
// unreachable, must never cost the run its tracking.
func TestCheckBackendVersionDegradesWhenHandshakeUnavailable(t *testing.T) {
	for name, err := range map[string]error{
		"unsupported": fmt.Errorf("%w: HTTP 404", tracker.ErrVersionUnsupported),
		"unreachable": errors.New("connection refused"),
	} {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			fake := newFake(tracker.BackendVersion{}, err)
			if got := checkBackendVersion(context.Background(), fake, testDSN, &buf); got != nil {
				t.Fatalf("checkBackendVersion = %v, want nil (degrade, never fail)", got)
			}
			if !strings.Contains(buf.String(), "warning") {
				t.Fatalf("expected a warning, got %q", buf.String())
			}
		})
	}
}

// noop:// has no deployment to interrogate; the handshake is skipped.
func TestCheckBackendVersionSkipsNoopTracker(t *testing.T) {
	var buf bytes.Buffer
	tr, err := tracker.Open("noop://")
	if err != nil {
		t.Fatal(err)
	}
	if got := checkBackendVersion(context.Background(), tr, "noop://", &buf); got != nil {
		t.Fatalf("checkBackendVersion(noop) = %v, want nil", got)
	}
	if strings.Contains(buf.String(), "error") {
		t.Fatalf("noop handshake printed an error: %q", buf.String())
	}
}

func TestPushFunctionsCommand(t *testing.T) {
	if got := pushFunctionsCommand("convex+https://example.convex.cloud"); got != "bash db/docker/push-functions.sh https://example.convex.cloud" {
		t.Fatalf("pushFunctionsCommand = %q", got)
	}
	if got := pushFunctionsCommand("noop://"); got != "cd db && bunx convex deploy" {
		t.Fatalf("pushFunctionsCommand(noop) = %q", got)
	}
}
