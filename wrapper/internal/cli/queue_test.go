package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/queue"
	"github.com/nkls-ai/dftstream/internal/submit"
	"github.com/nkls-ai/dftstream/internal/tracker"
	"github.com/nkls-ai/dftstream/internal/version"
)

// fakeConvex is a minimal Convex HTTP API: it dispatches on the function
// path and records every call, so tests can assert exactly what reached the
// backend without a real deployment.
type fakeConvex struct {
	mu    sync.Mutex
	calls map[string][]map[string]any
	// reply per function path; unhandled paths get a Convex-shaped error.
	replies map[string]any
}

func newFakeConvex() *fakeConvex {
	return &fakeConvex{calls: map[string][]map[string]any{}, replies: map[string]any{
		"meta:version": map[string]any{
			"apiVersion":           version.APIVersion,
			"minWrapperApiVersion": version.APIVersion - 1,
			"features":             []string{},
		},
	}}
}

func (f *fakeConvex) callsFor(path string) []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.calls[path]...)
}

func (f *fakeConvex) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Path string         `json:"path"`
			Args map[string]any `json:"args"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("fake convex: bad request body: %v", err)
			w.WriteHeader(400)
			return
		}
		f.mu.Lock()
		f.calls[req.Path] = append(f.calls[req.Path], req.Args)
		reply, ok := f.replies[req.Path]
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(200)
			fmt.Fprintf(w, `{"status":"error","errorMessage":"no fake for %s"}`, req.Path) //nolint:errcheck — test writer
			return
		}
		body, err := json.Marshal(map[string]any{"status": "success", "value": reply})
		if err != nil {
			t.Errorf("fake convex: marshal reply: %v", err)
			w.WriteHeader(500)
			return
		}
		if _, err := w.Write(body); err != nil {
			t.Errorf("fake convex: write reply: %v", err)
		}
	}
}

// queueTestEnv isolates credentials/config and points the tracker env at url.
func queueTestEnv(t *testing.T, url string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("DFTSTREAM_TRACKER_URL", "convex+"+url)
	t.Setenv("DFTSTREAM_ORG", "")
}

func testSubmitRequestForRegister() submit.Request {
	return submit.Request{
		Cluster:    submit.Cluster{Name: "hpc1", Scheduler: submit.SchedulerSlurm},
		Experiment: "CCC_SeO",
	}
}

func TestRegisterSubmittedJobsReportsToBackend(t *testing.T) {
	fake := newFakeConvex()
	fake.replies["experiments:ensure"] = "exp123"
	fake.replies["queue:register"] = "qj1"
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()
	queueTestEnv(t, srv.URL)

	req := testSubmitRequestForRegister()
	req.Array = true
	req.Throttle = 8
	job := submit.Job{Name: "batch", Array: true, Inputs: []string{"a.inp", "b.inp", "c.inp"}}
	registerSubmittedJobs(req, []submittedJob{{job: job, jobID: "4242"}})

	regs := fake.callsFor("queue:register")
	if len(regs) != 1 {
		t.Fatalf("queue:register called %d times, want 1", len(regs))
	}
	got := regs[0]
	for key, want := range map[string]any{
		"experimentId":   "exp123",
		"cluster":        "hpc1",
		"scheduler":      "slurm",
		"schedulerJobId": "4242",
		"inputBasename":  "batch",
		"arraySpec":      "1-3%8",
		"taskCount":      float64(3),
	} {
		if got[key] != want {
			t.Errorf("register arg %s = %v, want %v", key, got[key], want)
		}
	}
}

func TestRegisterSubmittedJobsIsBestEffortWhenBackendDown(t *testing.T) {
	// A port nothing listens on: registration must warn and return — never
	// hang for the full retry ladder, never panic, never fail submission
	// (the function has no failure channel by design).
	queueTestEnv(t, "http://127.0.0.1:1")
	req := testSubmitRequestForRegister()
	job := submit.Job{Name: "x", Inputs: []string{"x.inp"}}
	done := make(chan struct{})
	go func() {
		registerSubmittedJobs(req, []submittedJob{{job: job, jobID: "1"}})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("registration against a dead backend did not return within its budget")
	}
}

func TestParseJobIDFromSbatchReplies(t *testing.T) {
	cases := map[string]struct {
		id string
		ok bool
	}{
		"Submitted batch job 4242":                {"4242", true},
		"Submitted batch job 4242 on cluster hpc": {"4242", true},
		"sbatch: error: invalid partition":        {"", false},
		"":                                        {"", false},
	}
	for reply, want := range cases {
		id, ok := submit.ParseJobID(reply)
		if id != want.id || ok != want.ok {
			t.Errorf("ParseJobID(%q) = (%q, %v), want (%q, %v)", reply, id, ok, want.id, want.ok)
		}
	}
}

// stubSchedulerCLI installs stub scheduler commands as the only PATH entries
// (same pattern as internal/queue's tests).
func stubSchedulerCLI(t *testing.T, scripts map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatalf("write stub %s: %v", name, err)
		}
	}
	t.Setenv("PATH", dir)
	return dir
}

func TestQueuePassExecutesCancelRequestsAndPushesStates(t *testing.T) {
	fake := newFakeConvex()
	fake.replies["queue:listActive"] = []map[string]any{
		{
			"_id": "qj1", "experimentId": "exp1", "cluster": "hpc1",
			"schedulerJobId": "4242", "inputBasename": "x.inp",
			"state": "pending", "cancelRequested": true, "submittedAt": 1,
		},
		{
			"_id": "qj2", "experimentId": "exp1", "cluster": "hpc1",
			"schedulerJobId": "4243", "inputBasename": "y.inp",
			"state": "pending", "submittedAt": 2,
		},
	}
	fake.replies["queue:updateStates"] = []map[string]any{}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()
	queueTestEnv(t, srv.URL)

	dir := stubSchedulerCLI(t, map[string]string{
		// After the scancel, squeue reports the job as cancelled.
		"squeue":  `printf '4242|CANCELLED\n4243|RUNNING\n'`,
		"scancel": `echo "$@" > "${0%/*}/scancel.args"`,
	})

	ct, err := tracker.OpenConvex("convex+"+srv.URL, nil)
	if err != nil {
		t.Fatalf("open tracker: %v", err)
	}
	n, err := queuePass(context.Background(), ct, "", "", true)
	if err != nil {
		t.Fatalf("queuePass: %v", err)
	}
	if n != 2 {
		t.Errorf("queuePass saw %d jobs, want 2", n)
	}

	// The cancel-requested job was scancel'd...
	argv, err := os.ReadFile(filepath.Join(dir, "scancel.args"))
	if err != nil {
		t.Fatalf("scancel was not invoked: %v", err)
	}
	if strings.TrimSpace(string(argv)) != "4242" {
		t.Errorf("scancel argv = %q, want 4242", argv)
	}

	// ...and both observed states were pushed.
	pushes := fake.callsFor("queue:updateStates")
	if len(pushes) != 1 {
		t.Fatalf("queue:updateStates called %d times, want 1", len(pushes))
	}
	items, ok := pushes[0]["items"].([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("updateStates items = %v, want 2 items", pushes[0]["items"])
	}
	states := map[string]string{}
	for _, it := range items {
		m := it.(map[string]any)
		states[m["id"].(string)] = m["state"].(string)
	}
	if states["qj1"] != string(queue.StateCancelled) || states["qj2"] != string(queue.StateRunning) {
		t.Errorf("pushed states = %v, want qj1=cancelled qj2=running", states)
	}
}

func TestQueuePassStatusOnlyDoesNotCancel(t *testing.T) {
	fake := newFakeConvex()
	fake.replies["queue:listActive"] = []map[string]any{
		{
			"_id": "qj1", "experimentId": "exp1", "cluster": "hpc1",
			"schedulerJobId": "4242", "inputBasename": "x.inp",
			"state": "running", "cancelRequested": true, "submittedAt": 1,
		},
	}
	fake.replies["queue:updateStates"] = []map[string]any{}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()
	queueTestEnv(t, srv.URL)

	dir := stubSchedulerCLI(t, map[string]string{
		"squeue":  `printf '4242|RUNNING\n'`,
		"scancel": `echo "$@" > "${0%/*}/scancel.args"`,
	})
	ct, err := tracker.OpenConvex("convex+"+srv.URL, nil)
	if err != nil {
		t.Fatalf("open tracker: %v", err)
	}
	if _, err := queuePass(context.Background(), ct, "", "", false); err != nil {
		t.Fatalf("queuePass: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "scancel.args")); err == nil {
		t.Error("status-only pass ran scancel; only watch may act on cancel requests")
	}
}

func TestQueueStatusCmdOffClusterSaysLoginNode(t *testing.T) {
	fake := newFakeConvex()
	fake.replies["queue:listActive"] = []map[string]any{
		{
			"_id": "qj1", "experimentId": "exp1", "cluster": "hpc1",
			"schedulerJobId": "4242", "inputBasename": "x.inp",
			"state": "pending", "submittedAt": 1,
		},
	}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()
	queueTestEnv(t, srv.URL)
	t.Setenv("PATH", t.TempDir()) // no squeue anywhere

	if code := queueStatusCmd(nil); code != 1 {
		t.Errorf("queue status off-cluster exit = %d, want 1", code)
	}
}

func TestQueueCancelCmdUnregisteredJobIdStillCancels(t *testing.T) {
	fake := newFakeConvex()
	fake.replies["queue:listActive"] = []map[string]any{}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()
	queueTestEnv(t, srv.URL)
	dir := stubSchedulerCLI(t, map[string]string{
		"scancel": `echo "$@" > "${0%/*}/scancel.args"`,
	})

	if code := queueCancelCmd([]string{"777"}); code != 0 {
		t.Fatalf("queue cancel exit = %d, want 0", code)
	}
	argv, err := os.ReadFile(filepath.Join(dir, "scancel.args"))
	if err != nil {
		t.Fatalf("scancel was not invoked: %v", err)
	}
	if strings.TrimSpace(string(argv)) != "777" {
		t.Errorf("scancel argv = %q, want 777", argv)
	}
}

func TestQueueCancelCmdRegisteredJobUpdatesBackend(t *testing.T) {
	fake := newFakeConvex()
	fake.replies["queue:listActive"] = []map[string]any{
		{
			"_id": "qj9", "experimentId": "exp1", "cluster": "hpc1",
			"schedulerJobId": "555", "inputBasename": "z.inp",
			"state": "pending", "submittedAt": 1,
		},
	}
	fake.replies["queue:updateStates"] = []map[string]any{}
	srv := httptest.NewServer(fake.handler(t))
	defer srv.Close()
	queueTestEnv(t, srv.URL)
	stubSchedulerCLI(t, map[string]string{"scancel": `exit 0`})

	// Cancelling by input name resolves through the registered job.
	if code := queueCancelCmd([]string{"z.inp"}); code != 0 {
		t.Fatalf("queue cancel exit = %d, want 0", code)
	}
	pushes := fake.callsFor("queue:updateStates")
	if len(pushes) != 1 {
		t.Fatalf("queue:updateStates called %d times, want 1", len(pushes))
	}
	items := pushes[0]["items"].([]any)
	m := items[0].(map[string]any)
	if m["id"] != "qj9" || m["state"] != string(queue.StateCancelled) {
		t.Errorf("updateStates item = %v, want qj9 cancelled", m)
	}
}
