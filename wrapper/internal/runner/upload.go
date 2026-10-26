package runner

import (
	"context"
	"path/filepath"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// uploadArtifacts gathers the input file, the captured stdout, and any
// files in the run's cwd that ORCA produced (matching the input stem),
// then pushes the manifest to the tracker. The artifact level controls
// which file types are included; anything heavier than the level is
// dropped.
//
// derived carries artifacts DFTStream produced itself and deliberately
// never wrote into the chemist's directory (the .property.json converted
// in a scratch dir, for instance). They ride in the same atomic
// SetArtifacts as everything else. A derived artifact whose name already
// exists on disk is dropped in favour of the on-disk file — ORCA's own
// output always wins.
func uploadArtifacts(
	ctx context.Context,
	tr tracker.Tracker,
	runID tracker.RunID,
	opts Options,
	inputBytes []byte,
	stdoutCap *artifacts.CapWriter,
	startedAt time.Time,
	derived []artifacts.Artifact,
) error {
	if opts.ArtifactLevel == levels.ArtifactsNone {
		return nil
	}
	stem := DefaultRunName(opts.InputPath) // basename without extension
	inputName := filepath.Base(opts.InputPath)

	// Input is part of every non-none level — go through the same
	// preview+chunk machinery so very large input files don't blow up
	// the artifact row.
	inputArt := artifacts.Artifact{
		Name:      inputName,
		Path:      opts.InputPath,
		Kind:      artifacts.KindInput,
		SizeBytes: int64(len(inputBytes)),
		MTime:     startedAt,
	}
	artifacts.AttachContent(&inputArt, inputBytes)
	items := []tracker.Artifact{inputArt}

	// Collect cwd files first so we can tell whether ORCA's canonical .out
	// landed on disk (it does when the operator redirected stdout, e.g.
	// `dftstream run x.inp > x.out`). The disk .out is the full, byte-exact
	// output; our live stdout capture is only a 128 MB head snapshot. When the
	// canonical .out is present we drop the redundant .stdout.out artifact.
	outName := stem + ".out"
	cwdArts, err := artifacts.Collect(filepath.Dir(opts.InputPath), stem, startedAt, opts.ArtifactLevel)
	if err != nil {
		// Collect keeps every artifact it managed to build and reports the
		// rest, so whatever came back is still worth uploading — but the
		// files it could NOT read are a hole in the run's record and the
		// operator has to hear about it. (Before this, an unreadable .out
		// became a silently empty artifact row.)
		if opts.Logger != nil {
			opts.Logger.Warn("some artifacts could not be read", map[string]any{
				"error": err.Error(), "collected": len(cwdArts),
			})
		}
	}

	// A canonical .out only supersedes stdout if it actually carries content
	// (a 0-byte or unreadable .out leaves ContentText/Body empty). Both this
	// .out and the stdout fallback ride in the SAME atomic SetArtifacts call,
	// so we can never end up with neither: if the upload fails the whole
	// manifest rolls back and the local files are untouched.
	haveCanonicalOut := false
	for _, a := range cwdArts {
		if a.Name == outName && (a.ContentText != "" || len(a.Body) > 0) {
			haveCanonicalOut = true
			break
		}
	}

	if stdoutCap != nil && !haveCanonicalOut {
		items = append(items,
			artifacts.FromStdout(stem+".stdout.out", stdoutCap),
		)
	}

	onDisk := make(map[string]bool, len(cwdArts))
	for _, a := range cwdArts {
		onDisk[a.Name] = true
		// Skip the input itself — we already added it above with its source path.
		if a.Name == inputName {
			continue
		}
		items = append(items, a)
	}

	for _, a := range derived {
		if onDisk[a.Name] || a.Name == inputName {
			continue
		}
		items = append(items, a)
	}

	return tr.SetArtifacts(ctx, runID, items)
}
