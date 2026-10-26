package queue

import "testing"

func TestFromSlurmMapsDocumentedStates(t *testing.T) {
	cases := map[string]State{
		// squeue -o %T long forms.
		"PENDING":       StatePending,
		"RUNNING":       StateRunning,
		"COMPLETING":    StateRunning,
		"SUSPENDED":     StateRunning,
		"COMPLETED":     StateCompleted,
		"FAILED":        StateFailed,
		"TIMEOUT":       StateFailed,
		"NODE_FAIL":     StateFailed,
		"BOOT_FAIL":     StateFailed,
		"DEADLINE":      StateFailed,
		"OUT_OF_MEMORY": StateFailed,
		"CANCELLED":     StateCancelled,
		"PREEMPTED":     StateCancelled,
		"CONFIGURING":   StatePending,
		"REQUEUED":      StatePending,

		// Compact codes.
		"PD":  StatePending,
		"R":   StateRunning,
		"CG":  StateRunning,
		"CD":  StateCompleted,
		"F":   StateFailed,
		"TO":  StateFailed,
		"OOM": StateFailed,
		"CA":  StateCancelled,
		"PR":  StateCancelled,

		// sacct decorations.
		"CANCELLED by 40125": StateCancelled,
		"CANCELLED+":         StateCancelled,
		"FAILED+":            StateFailed,

		// Whitespace and case never change the answer.
		"  running  ": StateRunning,
		"pending":     StatePending,

		// Anything unrecognized is unknown, never a guess.
		"":              StateUnknown,
		"RESV_DEL_HOLD": StateUnknown,
		"garbage":       StateUnknown,
	}
	for raw, want := range cases {
		if got := FromSlurm(raw); got != want {
			t.Errorf("FromSlurm(%q) = %s, want %s", raw, got, want)
		}
	}
}

func TestTerminal(t *testing.T) {
	for _, s := range []State{StateCompleted, StateFailed, StateCancelled} {
		if !s.Terminal() {
			t.Errorf("%s.Terminal() = false, want true", s)
		}
	}
	// Unknown is not terminal: the watcher must keep polling it.
	for _, s := range []State{StatePending, StateRunning, StateUnknown} {
		if s.Terminal() {
			t.Errorf("%s.Terminal() = true, want false", s)
		}
	}
}

func TestAggregatePrefersTheStateThatStillMoves(t *testing.T) {
	cases := []struct {
		in   []State
		want State
	}{
		{nil, StateUnknown},
		{[]State{StateCompleted}, StateCompleted},
		// Any task still on a node → the job is running.
		{[]State{StateCompleted, StateRunning, StatePending}, StateRunning},
		// Nothing running but tasks queued → pending.
		{[]State{StateCompleted, StatePending}, StatePending},
		// All finished: a failure outranks a cancel outranks success.
		{[]State{StateCompleted, StateCancelled, StateFailed}, StateFailed},
		{[]State{StateCompleted, StateCancelled}, StateCancelled},
		{[]State{StateCompleted, StateCompleted}, StateCompleted},
		// An unclassifiable task keeps the job on the watch list.
		{[]State{StateCompleted, StateUnknown}, StateUnknown},
	}
	for _, c := range cases {
		if got := Aggregate(c.in); got != c.want {
			t.Errorf("Aggregate(%v) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestBaseJobID(t *testing.T) {
	cases := map[string]string{
		"123":          "123",
		"123_7":        "123",
		"123_[8-24%8]": "123",
	}
	for in, want := range cases {
		if got := BaseJobID(in); got != want {
			t.Errorf("BaseJobID(%q) = %q, want %q", in, got, want)
		}
	}
}
