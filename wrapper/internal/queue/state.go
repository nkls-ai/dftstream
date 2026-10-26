// Package queue talks to the cluster scheduler about jobs `dftstream
// submit` queued: polling their states (squeue, with an sacct fallback for
// jobs that already left the queue) and cancelling them (scancel).
//
// It deliberately knows nothing about the tracking backend — the backend can
// never reach the cluster, so this package is the login-node half of the
// queue feature: internal/tracker reports what this package observes.
package queue

import (
	"errors"
	"strings"
)

// ErrNoScheduler means the scheduler commands are not on this machine —
// almost always because the user is not on a login node. Mirrors
// submit.ErrNoScheduler, kept separate so this package stays free of the
// submit package's config machinery.
var ErrNoScheduler = errors.New("scheduler command not found")

// State is the coarse lifecycle of a submitted job, mirroring SLURM's job
// states the way the backend stores them (db/convex/schema.ts
// QUEUED_JOB_STATE). The wire values ARE these strings; both sides validate
// against the closed set.
type State string

const (
	StatePending   State = "pending"
	StateRunning   State = "running"
	StateCompleted State = "completed"
	StateFailed    State = "failed"
	StateCancelled State = "cancelled"
	StateUnknown   State = "unknown"
)

// States lists every member, for validation and tests.
var States = []State{
	StatePending, StateRunning, StateCompleted, StateFailed, StateCancelled, StateUnknown,
}

func (s State) String() string { return string(s) }

// Terminal reports whether the scheduler is done with the job — the state
// can no longer change on its own. Unknown is NOT terminal: it means the
// watcher could not classify what it saw and should keep polling.
func (s State) Terminal() bool {
	switch s {
	case StateCompleted, StateFailed, StateCancelled:
		return true
	}
	return false
}

// fromSlurmWord maps one normalized SLURM state word (long or compact form)
// onto the coarse state. The long forms are what `squeue -o %T` and sacct
// print; the compact codes cover sites whose wrappers reformat output.
var fromSlurmWord = map[string]State{
	// Waiting for resources or a requeue.
	"PENDING": StatePending, "PD": StatePending,
	"CONFIGURING": StatePending, "CF": StatePending,
	"REQUEUED": StatePending, "RQ": StatePending,
	"REQUEUE_FED": StatePending, "REQUEUE_HOLD": StatePending,
	"RESIZING": StatePending, "RS": StatePending,

	// On a node (including the winding-down states).
	"RUNNING": StateRunning, "R": StateRunning,
	"COMPLETING": StateRunning, "CG": StateRunning,
	"SUSPENDED": StateRunning, "S": StateRunning,
	"STOPPED": StateRunning, "ST": StateRunning,
	"SIGNALING": StateRunning, "SI": StateRunning,
	"STAGE_OUT": StateRunning, "SO": StateRunning,

	// Done, exit 0.
	"COMPLETED": StateCompleted, "CD": StateCompleted,

	// Done, the scheduler's fault or the job's.
	"FAILED": StateFailed, "F": StateFailed,
	"TIMEOUT": StateFailed, "TO": StateFailed,
	"NODE_FAIL": StateFailed, "NF": StateFailed,
	"BOOT_FAIL": StateFailed, "BF": StateFailed,
	"DEADLINE": StateFailed, "DL": StateFailed,
	"OUT_OF_MEMORY": StateFailed, "OOM": StateFailed,

	// Killed from outside the job.
	"CANCELLED": StateCancelled, "CA": StateCancelled,
	"PREEMPTED": StateCancelled, "PR": StateCancelled,
	"REVOKED": StateCancelled, "RV": StateCancelled,
}

// FromSlurm maps a raw SLURM state string onto the coarse State. It accepts
// the decorations sacct adds: "CANCELLED by 12345" (the reason tail) and a
// trailing "+" on truncated columns. Anything unrecognized maps to
// StateUnknown — never to a guess.
func FromSlurm(raw string) State {
	word := strings.ToUpper(strings.TrimSpace(raw))
	// "CANCELLED by 12345" → first word carries the state.
	if i := strings.IndexAny(word, " \t"); i >= 0 {
		word = word[:i]
	}
	word = strings.TrimSuffix(word, "+")
	if s, ok := fromSlurmWord[word]; ok {
		return s
	}
	return StateUnknown
}

// severity orders states for aggregating an array job's tasks into one
// coarse job state: anything still moving outranks anything finished, and
// among finished states a failure outranks a cancel outranks success — the
// state a chemist most needs to see first.
var severity = map[State]int{
	StateRunning:   6,
	StatePending:   5,
	StateUnknown:   4,
	StateFailed:    3,
	StateCancelled: 2,
	StateCompleted: 1,
}

// Aggregate folds the states of an array job's tasks (or several sacct rows
// for one job) into one coarse state. Empty input is StateUnknown.
func Aggregate(states []State) State {
	agg := StateUnknown
	best := 0
	for _, s := range states {
		if severity[s] > best {
			best = severity[s]
			agg = s
		}
	}
	return agg
}
