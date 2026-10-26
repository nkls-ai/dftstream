package queue

import (
	"fmt"
	"os/exec"
	"strings"
)

// BaseJobID strips the array-task suffix: "123_7" and "123_[8-24%8]" both
// belong to job "123". A plain id comes back unchanged.
func BaseJobID(id string) string {
	if i := strings.Index(id, "_"); i >= 0 {
		return id[:i]
	}
	return id
}

// ParseSqueue reads `squeue -h -o "%i|%T"` output and returns the observed
// states of the wanted jobs, keyed by BASE job id. Array jobs appear as
// several lines (one per running task, plus one "123_[..]" line for the
// still-pending tasks); each contributes one state and the caller
// aggregates. Lines for jobs nobody asked about are ignored, as are
// malformed lines — squeue chatter (warnings, motd injections) must never
// crash a poll.
func ParseSqueue(output string, wanted map[string]bool) map[string][]State {
	observed := map[string][]State{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		id, stateRaw, ok := strings.Cut(line, "|")
		if !ok {
			continue
		}
		base := BaseJobID(strings.TrimSpace(id))
		if !wanted[base] {
			continue
		}
		observed[base] = append(observed[base], FromSlurm(stateRaw))
	}
	return observed
}

// ParseSacct reads `sacct -n -P -X -o JobID,State` output and returns the
// observed states keyed by BASE job id. -P makes the format stable
// (pipe-separated, no padding); -X keeps it to whole jobs (no ".batch" and
// ".0" step rows). Array tasks appear as "123_7|COMPLETED".
func ParseSacct(output string) map[string][]State {
	observed := map[string][]State{}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		id, stateRaw, ok := strings.Cut(line, "|")
		if !ok {
			continue
		}
		base := BaseJobID(strings.TrimSpace(id))
		if base == "" {
			continue
		}
		observed[base] = append(observed[base], FromSlurm(stateRaw))
	}
	return observed
}

// runner abstracts command execution so tests can substitute a stub PATH; in
// production it is exec.Command. Kept package-private: the seam is the PATH,
// not this type — tests install stub squeue/sacct/scancel scripts.

// lookPath resolves a scheduler command or reports ErrNoScheduler with the
// on-a-login-node hint every caller wants.
func lookPath(name string) (string, error) {
	bin, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("%w: %s (are you on a login node?)", ErrNoScheduler, name)
	}
	return bin, nil
}

// SqueueStates polls squeue for the given scheduler job ids (base ids) and
// returns each job's observed per-task states. Jobs absent from the output
// simply have no entry — they left the queue; ask sacct.
func SqueueStates(jobIDs []string) (map[string][]State, error) {
	if len(jobIDs) == 0 {
		return map[string][]State{}, nil
	}
	bin, err := lookPath("squeue")
	if err != nil {
		return nil, err
	}
	// The full queue listing is filtered client-side: `-j` errors out on ids
	// that already left the queue, which is exactly the common case here.
	out, err := exec.Command(bin, "-h", "-o", "%i|%T").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("squeue failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	wanted := map[string]bool{}
	for _, id := range jobIDs {
		wanted[BaseJobID(id)] = true
	}
	return ParseSqueue(string(out), wanted), nil
}

// SacctStates asks the accounting database about jobs squeue no longer
// shows. Sites without accounting return an error; the caller treats that as
// "no answer" (the jobs stay unknown), not as a failed poll.
func SacctStates(jobIDs []string) (map[string][]State, error) {
	if len(jobIDs) == 0 {
		return map[string][]State{}, nil
	}
	bin, err := lookPath("sacct")
	if err != nil {
		return nil, err
	}
	args := []string{"-n", "-P", "-X", "-o", "JobID,State", "-j", strings.Join(jobIDs, ",")}
	out, err := exec.Command(bin, args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("sacct failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return ParseSacct(string(out)), nil
}

// Cancel runs scancel for one scheduler job id (base id cancels every task
// of an array job).
func Cancel(jobID string) error {
	bin, err := lookPath("scancel")
	if err != nil {
		return err
	}
	out, err := exec.Command(bin, jobID).CombinedOutput()
	if err != nil {
		reply := strings.TrimSpace(string(out))
		if reply == "" {
			return fmt.Errorf("scancel %s failed: %w", jobID, err)
		}
		return fmt.Errorf("scancel %s failed: %w: %s", jobID, err, reply)
	}
	return nil
}

// Poll resolves the current coarse state of every given job id: squeue for
// jobs still in the queue, sacct for the ones that left it. Jobs neither
// tool can account for come back StateUnknown. The returned map is keyed by
// the ids as given (base-id normalized).
func Poll(jobIDs []string) (map[string]State, error) {
	inQueue, err := SqueueStates(jobIDs)
	if err != nil {
		return nil, err
	}
	var gone []string
	for _, id := range jobIDs {
		if _, ok := inQueue[BaseJobID(id)]; !ok {
			gone = append(gone, BaseJobID(id))
		}
	}
	finished := map[string][]State{}
	if len(gone) > 0 {
		finished, err = SacctStates(gone)
		if err != nil {
			// No accounting on this site (or sacct hiccuped): the jobs that
			// left the queue stay unknown rather than failing the whole poll.
			finished = map[string][]State{}
		}
	}
	states := map[string]State{}
	for _, id := range jobIDs {
		base := BaseJobID(id)
		if obs, ok := inQueue[base]; ok {
			states[base] = Aggregate(obs)
			continue
		}
		if obs, ok := finished[base]; ok {
			states[base] = Aggregate(obs)
			continue
		}
		states[base] = StateUnknown
	}
	return states, nil
}
