package cli

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// listTimeout bounds the whole `dftstream list` round trip.
const listTimeout = 10 * time.Second

// ListCmd implements `dftstream list` — prints experiments straight from
// the configured backend.
//
// This only supports the Convex backend; for other DSNs it errors.
func ListCmd(args []string) int {
	if len(args) > 0 && (args[0] == "-h" || args[0] == "--help") {
		cliui.Title(os.Stderr, "dftstream list - prints experiments")
		return 0
	}
	orgID, ct, err := openConvexBackend(backendSpec{
		dsn:      resolveTrackerURL(""),
		openHint: "Use a Convex tracker URL, for example `convex+http://127.0.0.1:3210`.",
		// A listing has nothing to lose; listTimeout bounds it regardless.
		maxRetries: 2,
	})
	if err != nil {
		return exitCodeFor(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), listTimeout)
	defer cancel()

	exps, err := ct.ListExperiments(ctx, orgID)
	if err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("could not list experiments: %v", err), backendFixHint(err, "Make sure Convex is running from `db/` with `bun run dev`."))
		return 1
	}
	printExperiments(exps)
	return 0
}

func printExperiments(exps []tracker.ExperimentRef) {
	fmt.Printf("%-32s  %-30s  %s\n", "ID", "EXPERIMENT", "CREATED")
	for _, e := range exps {
		ts := time.UnixMilli(int64(e.CreatedAt)).Format(time.RFC3339)
		fmt.Printf("%-32s  %-30s  %s\n", e.ID, e.Name, ts)
	}
}
