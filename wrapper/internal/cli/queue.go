package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/queue"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// QueueCmd implements `dftstream queue <status|watch|cancel>` — the
// login-node half of scheduler-queue visibility. The backend can never
// reach the cluster, so this command is what turns squeue/sacct output
// into backend state and backend cancel requests into scancel calls.
// Exit codes: 0 ok, 1 failure, 2 usage error.
func QueueCmd(args []string) int {
	if len(args) == 0 {
		queueUsage()
		return 2
	}
	switch args[0] {
	case "status":
		return queueStatusCmd(args[1:])
	case "watch":
		return queueWatchCmd(args[1:])
	case "cancel":
		return queueCancelCmd(args[1:])
	case "-h", "--help", "help":
		queueUsage()
		return 0
	default:
		cliui.Error(os.Stderr, fmt.Sprintf("unknown queue subcommand %q", args[0]), "Use one of: status, watch, cancel.")
		queueUsage()
		return 2
	}
}

// queueFlags are the flags shared by every queue subcommand.
type queueFlags struct {
	backend backendFlags
	cluster string
}

func addQueueFlags(fs *flag.FlagSet, f *queueFlags) {
	f.backend.register(fs)
	fs.StringVar(&f.cluster, "cluster", "", "only jobs registered for this cluster (default: all)")
}

// openQueueBackend resolves credentials and opens the raw Convex tracker the
// queue calls live on. Unlike a run, a queue poll has no work to lose, so
// the retry ladder is kept short.
func openQueueBackend(f *queueFlags) (string, *tracker.ConvexHTTPTracker, error) {
	return openConvexBackend(backendSpec{
		dsn:        f.backend.dsn(),
		org:        f.backend.org,
		openHint:   "The queue commands need a Convex backend, e.g. `DFTSTREAM_TRACKER_URL=convex+http://127.0.0.1:3210`.",
		maxRetries: 2,
		handshake:  handshakeRequired,
	})
}

// schedulerFix is the hint printed whenever squeue/scancel are missing.
const schedulerFix = "Run this on a cluster login node — only there can dftstream reach squeue/scancel."

// --- status ------------------------------------------------------------------

func queueStatusCmd(args []string) int {
	fs := flag.NewFlagSet("queue status", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	f := &queueFlags{}
	addQueueFlags(fs, f)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	orgID, ct, err := openQueueBackend(f)
	if err != nil {
		return exitCodeFor(err)
	}
	defer closeQueueBackend(ct)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if _, err := queuePass(ctx, ct, orgID, f.cluster, false); err != nil {
		reportQueueError(err)
		return 1
	}
	return 0
}

// --- watch -------------------------------------------------------------------

func queueWatchCmd(args []string) int {
	fs := flag.NewFlagSet("queue watch", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	f := &queueFlags{}
	addQueueFlags(fs, f)
	interval := fs.Duration("interval", 30*time.Second, "poll interval")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *interval < time.Second {
		cliui.Error(os.Stderr, "poll interval must be at least 1s", "The scheduler controller is a shared resource; hammering it gets sites throttled.")
		return 2
	}
	orgID, ct, err := openQueueBackend(f)
	if err != nil {
		return exitCodeFor(err)
	}
	defer closeQueueBackend(ct)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cliui.Hint(os.Stderr, fmt.Sprintf("watching the queue every %s — Ctrl-C to stop", interval))
	for {
		if _, err := queuePass(ctx, ct, orgID, f.cluster, true); err != nil {
			if errors.Is(err, queue.ErrNoScheduler) || ctx.Err() != nil {
				reportQueueError(err)
				return 1
			}
			// Transient backend/scheduler hiccups must not kill a long-lived
			// watcher; say so and try again next tick.
			cliui.Warning(os.Stderr, fmt.Sprintf("poll failed (retrying in %s): %v", interval, err), "")
		}
		select {
		case <-ctx.Done():
			fmt.Fprintln(os.Stderr, "") //nolint:errcheck — write to stderr is best-effort
			cliui.Hint(os.Stderr, "queue watch stopped")
			return 0
		case <-time.After(*interval):
		}
	}
}

// queuePass is one poll: list registered active jobs, act on cancel requests
// (watch mode only), poll the scheduler, print the table, push state changes.
// Returns the number of jobs still active.
func queuePass(ctx context.Context, ct *tracker.ConvexHTTPTracker, orgID, cluster string, actOnCancels bool) (int, error) {
	jobs, err := ct.ListActiveQueuedJobs(ctx, orgID, cluster)
	if err != nil {
		return 0, err
	}
	if len(jobs) == 0 {
		cliui.Hint(os.Stderr, "no active registered jobs — `dftstream submit -submit` registers them")
		return 0, nil
	}

	if actOnCancels {
		for _, j := range jobs {
			if !j.CancelRequested || j.State.Terminal() {
				continue
			}
			if err := queue.Cancel(queue.BaseJobID(j.SchedulerJobID)); err != nil {
				if errors.Is(err, queue.ErrNoScheduler) {
					return 0, err
				}
				// The job may have finished between poll and scancel; the
				// state poll below settles what actually happened.
				cliui.Warning(os.Stderr, fmt.Sprintf("cancel of job %s failed: %v", j.SchedulerJobID, err), "")
				continue
			}
			cliui.Success(os.Stderr, fmt.Sprintf("job %s: cancel requested in the UI/CLI → scancel sent", j.SchedulerJobID))
		}
	}

	ids := make([]string, 0, len(jobs))
	for _, j := range jobs {
		ids = append(ids, queue.BaseJobID(j.SchedulerJobID))
	}
	states, err := queue.Poll(ids)
	if err != nil {
		return 0, err
	}

	printQueueTable(jobs, states)

	var updates []tracker.QueuedJobStateUpdate
	for _, j := range jobs {
		observed := states[queue.BaseJobID(j.SchedulerJobID)]
		if observed != j.State {
			updates = append(updates, tracker.QueuedJobStateUpdate{ID: j.ID, State: observed})
		}
	}
	if err := ct.UpdateQueuedJobStates(ctx, updates); err != nil {
		return 0, fmt.Errorf("push state updates: %w", err)
	}
	if n := len(updates); n > 0 {
		cliui.Hint(os.Stderr, fmt.Sprintf("pushed %d state update(s) to the backend", n))
	}
	return len(jobs), nil
}

// printQueueTable renders one poll's view. Stdout, machine-tolerant columns:
// the chatter around it stays on stderr.
func printQueueTable(jobs []tracker.QueuedJob, states map[string]queue.State) {
	sort.Slice(jobs, func(i, k int) bool { return jobs[i].SubmittedAt > jobs[k].SubmittedAt })
	w := tabwriter.NewWriter(os.Stdout, 2, 4, 2, ' ', 0)
	fmt.Fprintln(w, "JOBID\tSTATE\tCLUSTER\tINPUT\tAGE\tCANCEL") //nolint:errcheck — tabwriter buffers; Flush reports
	for _, j := range jobs {
		state := states[queue.BaseJobID(j.SchedulerJobID)]
		name := j.InputBasename
		if j.ArraySpec != "" {
			name += " [array " + j.ArraySpec + "]"
		}
		cancel := ""
		if j.CancelRequested {
			cancel = "requested"
		}
		age := "?"
		if j.SubmittedAt > 0 {
			age = formatAge(time.Since(time.UnixMilli(j.SubmittedAt)))
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", //nolint:errcheck — tabwriter buffers; Flush reports
			j.SchedulerJobID, strings.ToUpper(state.String()), j.Cluster, name, age, cancel)
	}
	if err := w.Flush(); err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("write table: %v", err), "")
	}
}

// formatAge renders a queue age the way squeue users read one: coarse,
// biggest unit first.
func formatAge(d time.Duration) string {
	switch {
	case d < 0:
		return "0s"
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	default:
		return fmt.Sprintf("%dd%02dh", int(d.Hours())/24, int(d.Hours())%24)
	}
}

// --- cancel ------------------------------------------------------------------

// jobIDish matches a raw scheduler job id ("123" or "123_7").
var jobIDish = regexp.MustCompile(`^\d+(_\d+)?$`)

func queueCancelCmd(args []string) int {
	fs := flag.NewFlagSet("queue cancel", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	f := &queueFlags{}
	addQueueFlags(fs, f)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		cliui.Error(os.Stderr, "expected exactly one job id or input name", "Example: dftstream queue cancel 4242   (or: dftstream queue cancel opt-freq_x.inp)")
		return 2
	}
	target := fs.Arg(0)
	orgID, ct, err := openQueueBackend(f)
	if err != nil {
		return exitCodeFor(err)
	}
	defer closeQueueBackend(ct)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	jobs, err := ct.ListActiveQueuedJobs(ctx, orgID, f.cluster)
	if err != nil {
		reportQueueError(err)
		return 1
	}
	matches := matchQueuedJobs(jobs, target)
	if len(matches) > 1 {
		var ids []string
		for _, m := range matches {
			ids = append(ids, m.SchedulerJobID)
		}
		cliui.Error(os.Stderr, fmt.Sprintf("%q matches %d active jobs (%s)", target, len(matches), strings.Join(ids, ", ")),
			"Cancel by scheduler job id instead.")
		return 1
	}
	if len(matches) == 0 {
		if !jobIDish.MatchString(target) {
			cliui.Error(os.Stderr, fmt.Sprintf("no active registered job matches %q", target),
				"Pass a scheduler job id, or run `dftstream queue status` to see what is registered.")
			return 1
		}
		// A raw id the backend has never heard of: still the user's job to
		// cancel — do it, just say the UI never knew about it.
		if err := queue.Cancel(queue.BaseJobID(target)); err != nil {
			reportQueueError(err)
			return 1
		}
		cliui.Success(os.Stderr, fmt.Sprintf("scancel %s sent (job was not registered with the backend)", target))
		return 0
	}

	m := matches[0]
	if err := queue.Cancel(queue.BaseJobID(m.SchedulerJobID)); err != nil {
		reportQueueError(err)
		return 1
	}
	cliui.Success(os.Stderr, fmt.Sprintf("scancel %s sent", m.SchedulerJobID))
	if err := ct.UpdateQueuedJobStates(ctx, []tracker.QueuedJobStateUpdate{
		{ID: m.ID, State: queue.StateCancelled},
	}); err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("job cancelled, but the backend was not updated: %v", err),
			"The next `dftstream queue status` poll will reconcile it.")
		return 1
	}
	return 0
}

// matchQueuedJobs finds the active jobs a cancel target names: scheduler
// job id first (exact or base), then input basename.
func matchQueuedJobs(jobs []tracker.QueuedJob, target string) []tracker.QueuedJob {
	var out []tracker.QueuedJob
	for _, j := range jobs {
		if j.SchedulerJobID == target || queue.BaseJobID(target) == j.SchedulerJobID {
			return []tracker.QueuedJob{j}
		}
	}
	for _, j := range jobs {
		if j.InputBasename == target {
			out = append(out, j)
		}
	}
	return out
}

// --- shared helpers ----------------------------------------------------------

func reportQueueError(err error) {
	fix := backendFixHint(err, "")
	if errors.Is(err, queue.ErrNoScheduler) {
		fix = schedulerFix
	}
	cliui.Error(os.Stderr, err.Error(), fix)
}

func closeQueueBackend(ct *tracker.ConvexHTTPTracker) {
	if err := ct.Close(context.Background()); err != nil {
		// The raw tracker buffers nothing; note it and move on.
		fmt.Fprintf(os.Stderr, "[dftstream] note: closing tracker: %v\n", err) //nolint:errcheck — write to stderr is best-effort
	}
}

func queueUsage() {
	cliui.Title(os.Stderr, "dftstream queue")
	fmt.Fprintf(os.Stderr, `
Usage:
  dftstream queue status [flags]            one poll: table + backend update
  dftstream queue watch  [flags]            poll on an interval; executes cancel
                                             requests made in the UI (scancel)
  dftstream queue cancel [flags] <jobid|input.inp>

Runs on a cluster login node (the only place squeue/scancel exist). The
backend never reaches the cluster: submit registers jobs, this command
reports their scheduler state and performs requested cancellations, the UI
displays and requests.

Flags (all subcommands): -tracker-url, -org, -cluster
Watch only: -interval (default 30s)
`)
}
