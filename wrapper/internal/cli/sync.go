package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/spool"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// syncMaxRetries is the retry-ladder length for sync's backend calls. Short
// on purpose: sync may legitimately run on a host with no route to the
// backend (the best-effort post-job hook on an offline compute node), where
// the default 8-attempt ladder would waste ~25s per journal.
const syncMaxRetries = 2

// syncOptions is the resolved configuration of one `dftstream sync`.
type syncOptions struct {
	trackerURL string
	orgFlag    string
	root       string
	keep       bool
	paths      []string
}

// SyncCmd implements `dftstream sync [flags] [journal-dir...]`: replay
// offline journals written by `dftstream run --offline` (or by the
// automatic failover when the tracker was unreachable) to the backend.
func SyncCmd(args []string) int {
	opts, err := parseSyncFlags(args)
	if err != nil {
		return exitCodeFor(err)
	}
	dirs, err := resolveJournalDirs(opts)
	if err != nil {
		return exitCodeFor(err)
	}
	if len(dirs) == 0 {
		cliui.Success(os.Stderr, "nothing to sync: no journals found under "+opts.root)
		return 0
	}

	replayer, err := openSyncBackend(opts)
	if err != nil {
		return exitCodeFor(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return syncJournals(ctx, dirs, replayer, opts.keep)
}

func parseSyncFlags(args []string) (syncOptions, error) {
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var backend backendFlags
	backend.register(fs)
	root := fs.String("root", "", "spool root to scan when no journal paths are given (default: env DFTSTREAM_SPOOL_DIR or ~/.local/state/dftstream/spool)")
	keep := fs.Bool("keep", false, "archive fully-synced journals (rename to <dir>.synced) instead of deleting them")
	showHelp := fs.Bool("help", false, "show help")
	fs.Usage = func() {
		cliui.Title(os.Stderr, "dftstream sync")
		fmt.Fprintf(os.Stderr, `
Usage:
  dftstream sync [flags] [journal-dir...]

Replays offline journals (written by `+"`dftstream run --offline`"+` or by the
automatic failover when the tracker was unreachable) to the backend. Run it
from a host that can reach the backend — on clusters, the login node.

Safe to re-run: progress is checkpointed per journal (cursor.json) and every
non-idempotent operation carries an idempotency key the backend deduplicates
on, so an interrupted sync resumes without duplicating data. Fully-synced
journals are deleted (or archived with -keep).

With no paths, every journal under the spool root is synced, oldest first.

Flags:
`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return syncOptions{}, exitStatus(0)
		}
		return syncOptions{}, exitStatus(2)
	}
	if *showHelp {
		fs.Usage()
		return syncOptions{}, exitStatus(0)
	}
	rootDir := *root
	if rootDir == "" {
		var err error
		rootDir, err = spool.DefaultRoot()
		if err != nil {
			cliui.Error(os.Stderr, err.Error(), "Set DFTSTREAM_SPOOL_DIR or pass journal directories explicitly.")
			return syncOptions{}, exitStatus(2)
		}
	}
	return syncOptions{
		trackerURL: backend.dsn(),
		orgFlag:    backend.org,
		root:       rootDir,
		keep:       *keep,
		paths:      fs.Args(),
	}, nil
}

// resolveJournalDirs turns the positional args (journal dirs or journal.jsonl
// files) — or, with none, a scan of the spool root — into an ordered list of
// journal directories, oldest first.
func resolveJournalDirs(opts syncOptions) ([]string, error) {
	if len(opts.paths) > 0 {
		dirs := make([]string, 0, len(opts.paths))
		for _, p := range opts.paths {
			abs, err := filepath.Abs(p)
			if err != nil {
				cliui.Error(os.Stderr, fmt.Sprintf("could not resolve path %q: %v", p, err), "")
				return nil, exitStatus(2)
			}
			if filepath.Base(abs) == filepath.Base(spool.JournalPath("")) {
				abs = filepath.Dir(abs)
			}
			if _, err := os.Stat(spool.JournalPath(abs)); err != nil {
				cliui.Error(os.Stderr, fmt.Sprintf("%s does not contain a spool journal: %v", abs, err), "Pass a journal directory (it holds journal.jsonl) or run without arguments to scan the spool root.")
				return nil, exitStatus(2)
			}
			dirs = append(dirs, abs)
		}
		return dirs, nil
	}

	entries, err := os.ReadDir(opts.root)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil // no spool root yet — nothing was ever journaled
	}
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not scan spool root %s: %v", opts.root, err), "")
		return nil, exitStatus(1)
	}
	var dirs []string
	for _, e := range entries {
		if !e.IsDir() || strings.HasSuffix(e.Name(), spool.SyncedDirSuffix) {
			continue
		}
		dir := filepath.Join(opts.root, e.Name())
		if _, err := os.Stat(spool.JournalPath(dir)); err != nil {
			// A directory without a journal file is not ours to touch; say so
			// once rather than silently skipping.
			fmt.Fprintf(os.Stderr, "[dftstream] skipping %s: no journal.jsonl (%v)\n", dir, err)
			continue
		}
		dirs = append(dirs, dir)
	}
	// Directory names start with the creation timestamp, so a lexical sort
	// replays whole journals oldest-first.
	sort.Strings(dirs)
	return dirs, nil
}

// openSyncBackend opens the raw Convex tracker, performs the version
// handshake (a definitive mismatch is fatal, exactly as for run), and
// verifies the deployment carries the spool replay guards.
func openSyncBackend(opts syncOptions) (tracker.SpoolReplayer, error) {
	// The org is not needed: journals carry their own org context.
	_, ct, err := openConvexBackend(backendSpec{
		dsn:        opts.trackerURL,
		org:        opts.orgFlag,
		openHint:   "`dftstream sync` needs a Convex backend DSN, e.g. DFTSTREAM_TRACKER_URL=convex+http://127.0.0.1:3210.",
		maxRetries: syncMaxRetries,
		handshake:  handshakeRequired,
	})
	if err != nil {
		return nil, err
	}
	// The replay guards are additive, so they are advertised as a feature
	// rather than an API version bump. Replaying against a backend without
	// them would duplicate runs/events on a re-sync — refuse with the fix.
	if bv, err := ct.BackendVersion(context.Background()); err == nil && !bv.HasFeature(tracker.FeatureSpool) {
		cliui.Error(os.Stderr,
			"this backend does not support spool replay (no \"spool\" feature in meta:version)",
			"Redeploy the Convex functions: "+pushFunctionsCommand(opts.trackerURL))
		return nil, exitStatus(2)
	}
	return ct, nil
}

// syncJournals replays each journal in order and prints the summary.
func syncJournals(ctx context.Context, dirs []string, replayer tracker.SpoolReplayer, keep bool) int {
	failed := 0
	for _, dir := range dirs {
		j, err := spool.Load(dir)
		if err != nil {
			cliui.Error(os.Stderr, fmt.Sprintf("%s: %v", dir, err), "")
			failed++
			continue
		}
		sum, err := spool.Replay(ctx, j, replayer)
		label := journalLabel(j)
		if err != nil {
			cliui.Error(os.Stderr, fmt.Sprintf("%s: sync stopped after %d op(s): %v", label, sum.Applied, err), backendFixHint(err, "Re-run `dftstream sync` to resume; already-uploaded operations are not repeated."))
			failed++
			if ctx.Err() != nil {
				break // interrupted — stop cleanly instead of erroring per journal
			}
			continue
		}
		fmt.Fprintf(os.Stderr, "[dftstream] %s: %d op(s) uploaded, %d already synced%s\n",
			label, sum.Applied, sum.Skipped, runList(sum.RunIDs))
		if sum.Tail != nil {
			// Valid prefix is uploaded; the journal is kept for forensics and
			// the loss is reported, never swallowed.
			cliui.Warning(os.Stderr, fmt.Sprintf("%s: %v", label, sum.Tail),
				"The journal was kept at "+dir+"; delete it yourself once the loss is understood.")
			failed++
			continue
		}
		if err := finishJournal(dir, keep); err != nil {
			cliui.Error(os.Stderr, err.Error(), "")
			failed++
		}
	}
	if failed > 0 {
		cliui.Error(os.Stderr, fmt.Sprintf("sync finished with %d of %d journal(s) unresolved", failed, len(dirs)), "")
		return 1
	}
	cliui.Success(os.Stderr, fmt.Sprintf("synced %d journal(s)", len(dirs)))
	return 0
}

// finishJournal removes (or, with keep, archives) a fully-synced journal.
func finishJournal(dir string, keep bool) error {
	if keep {
		dst := dir + spool.SyncedDirSuffix
		if err := os.Rename(dir, dst); err != nil {
			return fmt.Errorf("could not archive synced journal %s: %v", dir, err)
		}
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("could not delete synced journal %s: %v", dir, err)
	}
	return nil
}

// journalLabel names a journal in output: "experiment/run (dir-base)".
func journalLabel(j *spool.Journal) string {
	name := strings.TrimSuffix(filepath.Base(j.Dir), "/")
	if j.Header.RunName == "" {
		return name
	}
	if j.Header.ExperimentName != "" {
		return j.Header.ExperimentName + "/" + j.Header.RunName + " (" + name + ")"
	}
	return j.Header.RunName + " (" + name + ")"
}

// runList renders the backend run ids a journal landed in.
func runList(ids []tracker.RunID) string {
	if len(ids) == 0 {
		return ""
	}
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = string(id)
	}
	return " → run " + strings.Join(parts, ", ")
}
