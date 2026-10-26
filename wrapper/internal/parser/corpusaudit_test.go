package parser

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
)

// The parser's worst failure mode is silent. A regex that stops matching
// on a newer ORCA release does not error — the section simply yields no
// rows, the tolerant branch resets the state machine, and the run is
// recorded as though ORCA never printed the data. Nothing in the golden
// corpus above catches that, because the golden corpus only contains
// outputs whose shape we already knew.
//
// TestAuditCorpus is the counter-measure: point it at a directory tree of
// real .out files and it re-reads each one twice — once as text, counting
// the landmarks that are physically present, and once through the parser,
// counting the events those landmarks should have produced. A landmark
// that appears in the text but never in the events is the signature of
// exactly this bug.
//
// It found two on an 8842-file tree:
//
//   - every ORCA 6 absorption spectrum (100 of 100 files), because
//     reAbsRow only ever matched ORCA 5's bare state index;
//   - an MECP run's prose line counted as a third Hessian.
//
// Opt-in, because the corpus is not something the repository can carry:
//
//	DFTSTREAM_AUDIT_DIR=/path/to/outputs go test ./internal/parser -run Audit -v
//
// DFTSTREAM_AUDIT_ONLY=<landmark> narrows the report to one key.
//
// The tree is only ever READ. Nothing is written into it and no ORCA aux
// tool is pointed at it.
func TestAuditCorpus(t *testing.T) {
	root := os.Getenv("DFTSTREAM_AUDIT_DIR")
	if root == "" {
		t.Skip("set DFTSTREAM_AUDIT_DIR to a tree of real ORCA .out files")
	}

	files, err := findOutputs(root)
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	t.Logf("auditing %d outputs under %s", len(files), root)

	var (
		mu       sync.Mutex
		findings []string
		counts   = map[string]int{}
	)
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, path := range files {
		wg.Add(1)
		go func(path string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			problems, err := auditOutput(path)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				findings = append(findings, fmt.Sprintf("%s\n    %v", path, err))
				counts["read-error"]++
				return
			}
			if len(problems) == 0 {
				return
			}
			for _, p := range problems {
				counts[p.landmark]++
			}
			parts := make([]string, 0, len(problems))
			for _, p := range problems {
				parts = append(parts, p.String())
			}
			findings = append(findings, fmt.Sprintf("%s\n    %s", path, strings.Join(parts, " | ")))
		}(path)
	}
	wg.Wait()

	if only := os.Getenv("DFTSTREAM_AUDIT_ONLY"); only != "" {
		kept := findings[:0]
		for _, f := range findings {
			if strings.Contains(f, only+":") {
				kept = append(kept, f)
			}
		}
		findings = kept
	}

	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return counts[keys[i]] > counts[keys[j]] })
	t.Logf("=== %d of %d outputs have a landmark the parser did not turn into an event ===",
		len(findings), len(files))
	for _, k := range keys {
		t.Logf("  %-12s %d", k, counts[k])
	}

	sort.Strings(findings)
	const maxListed = 60
	for i, f := range findings {
		if i == maxListed {
			t.Logf("... and %d more", len(findings)-i)
			break
		}
		t.Log(f)
	}

	// Reporting only. Real ORCA output is varied enough that a brand-new
	// finding is a prompt to investigate, not automatically a regression —
	// the two bugs this found are pinned by their own unit tests above.
	if len(findings) > 0 {
		t.Logf("investigate each: a landmark present as text but absent from the event stream " +
			"is how a version-specific parse failure hides")
	}
}

func findOutputs(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// An unreadable subtree is not a reason to abandon the audit;
			// it just is not part of it.
			return nil //nolint:nilerr — skip what we cannot descend into
		}
		if !d.IsDir() && strings.HasSuffix(p, ".out") {
			out = append(out, p)
		}
		return nil
	})
	return out, err
}

// auditLandmarks maps a report key to the literal ORCA prints. Matching is
// deliberately dumb (substring, case-sensitive) so it stays independent of
// the parser's own matching — the whole point is to disagree with it.
var auditLandmarks = map[string]string{
	"finalsp": "FINAL SINGLE POINT ENERGY",
	"term":    "ORCA TERMINATED NORMALLY",
	"runtime": "TOTAL RUN TIME:",
	"totalE":  "Total Energy       :",
	"scfconv": "SCF CONVERGED AFTER",
	"gibbs":   "Final Gibbs free energy",
	"vib":     "VIBRATIONAL FREQUENCIES",
	"abs":     "ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS",
	"version": "Program Version",
}

type auditProblem struct {
	landmark string
	text, ev int
}

func (p auditProblem) String() string {
	return fmt.Sprintf("%s: text=%d event=%d", p.landmark, p.text, p.ev)
}

func auditOutput(path string) ([]auditProblem, error) {
	text, err := countLandmarks(path)
	if err != nil {
		return nil, err
	}
	ev, err := countEvents(path)
	if err != nil {
		return nil, err
	}
	var problems []auditProblem
	for key := range auditLandmarks {
		if text[key] > 0 && ev[key] == 0 {
			problems = append(problems, auditProblem{key, text[key], ev[key]})
		}
	}
	sort.Slice(problems, func(i, j int) bool { return problems[i].landmark < problems[j].landmark })
	return problems, nil
}

func countLandmarks(path string) (map[string]int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close() //nolint:errcheck — read-only handle
	counts := map[string]int{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	for sc.Scan() {
		line := sc.Text()
		for key, lit := range auditLandmarks {
			if strings.Contains(line, lit) {
				counts[key]++
			}
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("scan: %w", err)
	}
	return counts, nil
}

func countEvents(path string) (map[string]int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close() //nolint:errcheck — read-only handle

	ch := make(chan Event, 256)
	counts := map[string]int{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for e := range ch {
			switch ev := e.(type) {
			case FinalSPEvent:
				counts["finalsp"]++
			case RunEndEvent:
				if ev.Normal {
					counts["term"]++
				}
				if ev.Wallclock > 0 {
					counts["runtime"]++
				}
			case TotalEnergyEvent:
				counts["totalE"]++
			case ScfConvergedEvent:
				counts["scfconv"]++
			case ThermoEvent:
				if ev.GibbsEh != nil {
					counts["gibbs"]++
				}
			case FrequenciesEvent:
				counts["vib"]++
			case ExcitedStatesEvent:
				counts["abs"]++
			case RunStartEvent:
				if ev.OrcaVersion != "" {
					counts["version"]++
				}
			}
		}
	}()
	perr := New(nil).Parse(context.Background(), f, ch)
	close(ch)
	<-done
	if perr != nil {
		return nil, fmt.Errorf("parse: %w", perr)
	}
	return counts, nil
}
