package queue

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The fixtures below follow the formats the commands are invoked with:
// squeue -h -o "%i|%T" (one "<id>|<LONG_STATE>" line per job/task) and
// sacct -n -P -X -o JobID,State (pipe-separated, whole jobs only).

const squeueFixture = `4242|RUNNING
4243|PENDING
9000_3|RUNNING
9000_4|COMPLETING
9000_[5-24%8]|PENDING
7777|CANCELLED
someone-elses-job|RUNNING
`

func TestParseSqueueFixture(t *testing.T) {
	wanted := map[string]bool{"4242": true, "4243": true, "9000": true, "5555": true}
	got := ParseSqueue(squeueFixture, wanted)
	want := map[string][]State{
		"4242": {StateRunning},
		"4243": {StatePending},
		// One entry per task line: two on nodes, one bracket line still queued.
		"9000": {StateRunning, StateRunning, StatePending},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ParseSqueue = %v, want %v", got, want)
	}
	if _, ok := got["5555"]; ok {
		t.Error("job absent from squeue must have no entry (it left the queue)")
	}
	if _, ok := got["7777"]; ok {
		t.Error("jobs nobody asked about must be ignored")
	}
}

func TestParseSqueueIgnoresChatter(t *testing.T) {
	out := "squeue: error: some transient warning\n\n4242|RUNNING\nnot a squeue line at all\n"
	got := ParseSqueue(out, map[string]bool{"4242": true})
	if !reflect.DeepEqual(got, map[string][]State{"4242": {StateRunning}}) {
		t.Errorf("ParseSqueue with chatter = %v", got)
	}
}

const sacctFixture = `4242|COMPLETED
4243|CANCELLED by 40125
9000_1|COMPLETED
9000_2|FAILED
9000_3|OUT_OF_MEMORY
6001|TIMEOUT
`

func TestParseSacctFixture(t *testing.T) {
	got := ParseSacct(sacctFixture)
	want := map[string][]State{
		"4242": {StateCompleted},
		"4243": {StateCancelled},
		"9000": {StateCompleted, StateFailed, StateFailed},
		"6001": {StateFailed},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ParseSacct = %v, want %v", got, want)
	}
	if Aggregate(got["9000"]) != StateFailed {
		t.Errorf("array with failures must aggregate to failed, got %s", Aggregate(got["9000"]))
	}
}

// stubScheduler installs stub squeue/sacct/scancel scripts as the ONLY
// entries on PATH and returns the directory (for canary files the stubs
// write). Follows the shellsafety_test.go stub pattern.
func stubScheduler(t *testing.T, scripts map[string]string) string {
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

func TestPollUsesSqueueThenSacct(t *testing.T) {
	stubScheduler(t, map[string]string{
		"squeue": `printf '4242|RUNNING\n9000_1|PENDING\n'`,
		// Only the job that left the queue may be asked about.
		"sacct": `echo "$@" > "${0%/*}/sacct.args"; printf '5555|COMPLETED\n'`,
	})
	states, err := Poll([]string{"4242", "9000", "5555", "6666"})
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	want := map[string]State{
		"4242": StateRunning,
		"9000": StatePending,
		"5555": StateCompleted,
		// Neither tool accounts for it: unknown, never a guess.
		"6666": StateUnknown,
	}
	if !reflect.DeepEqual(states, want) {
		t.Errorf("Poll = %v, want %v", states, want)
	}
}

func TestPollSurvivesMissingSacct(t *testing.T) {
	stubScheduler(t, map[string]string{
		"squeue": `printf '4242|RUNNING\n'`,
		// No sacct stub: sites without accounting must not fail the poll.
	})
	states, err := Poll([]string{"4242", "5555"})
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if states["4242"] != StateRunning || states["5555"] != StateUnknown {
		t.Errorf("Poll = %v", states)
	}
}

func TestPollWithoutSchedulerSaysSo(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // nothing on PATH at all
	if _, err := Poll([]string{"1"}); !errors.Is(err, ErrNoScheduler) {
		t.Fatalf("Poll off-cluster = %v, want ErrNoScheduler", err)
	}
}

func TestCancelInvokesScancel(t *testing.T) {
	dir := stubScheduler(t, map[string]string{
		"scancel": `echo "$@" > "${0%/*}/scancel.args"`,
	})
	if err := Cancel("4242"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "scancel.args"))
	if err != nil {
		t.Fatalf("scancel was not invoked: %v", err)
	}
	if string(got) != "4242\n" {
		t.Errorf("scancel argv = %q, want %q", got, "4242\n")
	}
}

func TestCancelReportsSchedulerError(t *testing.T) {
	stubScheduler(t, map[string]string{
		"scancel": `echo 'scancel: error: Invalid job id' >&2; exit 1`,
	})
	err := Cancel("bogus")
	if err == nil {
		t.Fatal("Cancel of a rejected id returned nil")
	}
	if want := "Invalid job id"; !strings.Contains(err.Error(), want) {
		t.Errorf("error %q does not carry the scheduler's reply %q", err, want)
	}
}
