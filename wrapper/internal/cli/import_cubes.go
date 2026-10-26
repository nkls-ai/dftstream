package cli

import (
	"bytes"
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/cliui"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// importCubesOptions holds the parsed arguments of `dftstream
// import-cubes`.
type importCubesOptions struct {
	trackerURL string
	runID      string
	cubeFiles  []string
}

func ImportCubesCmd(args []string) (code int) {
	opts, err := parseImportCubesArgs(args)
	if err != nil {
		return exitCodeFor(err)
	}

	// The same credential path as every other backend command: without it
	// an auth-on backend refused the upload with no credential sent at all.
	_, tr, err := openAuthedTracker(resolveTrackerURL(opts.trackerURL), "",
		"Use `DFTSTREAM_TRACKER_URL=convex+http://127.0.0.1:3210` while Convex is running.")
	if err != nil {
		return exitCodeFor(err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	defer func() { code = flushCubeTracker(tr, code) }()

	items := collectCubeArtifacts(opts.cubeFiles)
	if len(items) == 0 {
		cliui.Error(os.Stderr, "no valid cube files found", "")
		return 1
	}

	if err := tr.AppendArtifacts(ctx, tracker.RunID(opts.runID), items); err != nil {
		cliui.Error(os.Stderr, fmt.Sprintf("upload failed: %v", err), backendFixHint(err, ""))
		return 1
	}

	fmt.Fprintf(os.Stderr, "Imported %d cube file(s) to run %s\n", len(items), opts.runID)
	return 0
}

func parseImportCubesArgs(args []string) (importCubesOptions, error) {
	fs := flag.NewFlagSet("import-cubes", flag.ContinueOnError)
	var backend backendFlags
	backend.registerTrackerURL(fs)
	if err := fs.Parse(args); err != nil {
		return importCubesOptions{}, exitStatus(2)
	}
	rest := fs.Args()
	if len(rest) < 2 {
		cliui.Error(os.Stderr, "usage: dftstream import-cubes <run-id> <file.cube> [file2.cube ...]", "")
		return importCubesOptions{}, exitStatus(2)
	}
	return importCubesOptions{
		trackerURL: backend.trackerURL,
		runID:      rest[0],
		cubeFiles:  rest[1:],
	}, nil
}

// collectCubeArtifacts reads each cube file into a tracker artifact,
// reporting and skipping unreadable ones.
func collectCubeArtifacts(cubeFiles []string) []tracker.Artifact {
	var items []tracker.Artifact
	for _, path := range cubeFiles {
		abs, err := filepath.Abs(path)
		if err != nil {
			cliui.Error(os.Stderr, "path", err.Error())
			continue
		}
		info, err := os.Stat(abs)
		if err != nil {
			cliui.Error(os.Stderr, "stat", err.Error())
			continue
		}

		data, err := os.ReadFile(abs)
		if err != nil {
			cliui.Error(os.Stderr, "read", err.Error())
			continue
		}
		content, truncated, body := cubeContent(data)
		label := cubeLabel(data, abs)
		name := filepath.Base(abs)

		items = append(items, tracker.Artifact{
			Name:        name,
			Path:        abs,
			Kind:        artifacts.KindCube,
			SizeBytes:   info.Size(),
			MTime:       info.ModTime(),
			ContentText: content,
			Truncated:   truncated,
			Body:        body,
		})

		fmt.Fprintf(os.Stderr, "  %s -> cube (%s)\n", name, label)
	}
	return items
}

// flushCubeTracker closes the tracker and folds a flush failure into
// the command's exit code: a flush failure means the cubes may not have
// persisted, so success must not be reported. Mirrors import.go's
// exit-code handling.
func flushCubeTracker(tr tracker.Tracker, code int) int {
	closeCtx, closeCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer closeCancel()
	if err := tr.Close(closeCtx); err != nil {
		cliui.Warning(os.Stderr, fmt.Sprintf("failed to flush tracker: %v", err), backendFixHint(err, ""))
		if code == 0 {
			return 1
		}
	}
	return code
}

// cubeContent splits a cube file's bytes into the inline preview, the
// truncation flag and the full body for file storage.
func cubeContent(data []byte) (string, bool, []byte) {
	var art artifacts.Artifact
	art.SizeBytes = int64(len(data))
	artifacts.AttachContent(&art, data)
	return art.ContentText, art.Truncated, art.Body
}

// cubeLabel is the cube's first (comment) line, or the file name when that
// line is blank. It works on the bytes already read for upload, so there is
// no second open of the file and no read error to lose.
func cubeLabel(data []byte, path string) string {
	first, _, _ := bytes.Cut(data, []byte("\n"))
	if line := strings.TrimSpace(string(first)); line != "" {
		return line
	}
	return filepath.Base(path)
}
