package runner

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/nkls-ai/dftstream/internal/artifacts"
	"github.com/nkls-ai/dftstream/internal/levels"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// NEB writes its path files continuously while the band optimizes, but the
// normal artifact upload only happens at finalize. The live syncer re-uploads
// just these text files on an interval so the UI's path switcher updates
// during the run. Strictly read-only on ORCA's files.
var nebLiveArtifactRE = regexp.MustCompile(`(?i)(\.interp|_MEP(_ALL)?_trj\.xyz|_MEP\.allxyz|_initial_path_trj\.xyz)$`)

const liveArtifactInterval = 60 * time.Second

type fileStamp struct {
	size  int64
	mtime time.Time
}

// startLiveArtifactSync launches the periodic NEB-artifact refresher. The
// returned stop function cancels it and waits for the goroutine to exit.
// No-op (returns immediately-done stop) when the run doesn't request a NEB
// band or artifacts are disabled.
func (s *runSession) startLiveArtifactSync(ctx context.Context) (stop func()) {
	if !s.summary.RequestsNEBBand() || s.opts.ArtifactLevel == levels.ArtifactsNone {
		return func() {}
	}
	syncCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		seen := map[string]fileStamp{}
		ticker := time.NewTicker(liveArtifactInterval)
		defer ticker.Stop()
		for {
			select {
			case <-syncCtx.Done():
				return
			case <-ticker.C:
				s.syncLiveArtifacts(syncCtx, seen)
			}
		}
	}()
	return func() {
		cancel()
		wg.Wait()
	}
}

// syncLiveArtifacts uploads every matching file whose (size, mtime) changed
// since the last tick. Errors are logged and retried on the next tick — a
// tracking hiccup must never disturb the run.
func (s *runSession) syncLiveArtifacts(ctx context.Context, seen map[string]fileStamp) {
	entries, err := os.ReadDir(s.workDir)
	if err != nil {
		s.log.Warn("live artifact sync: read dir failed", map[string]any{"error": err.Error()})
		return
	}
	var items []tracker.Artifact
	stamped := map[string]fileStamp{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !nebLiveArtifactRE.MatchString(name) {
			continue
		}
		if !(len(name) > len(s.stem) && (name[:len(s.stem)+1] == s.stem+"." || name[:len(s.stem)+1] == s.stem+"_")) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			s.log.Warn("live artifact sync: stat failed", map[string]any{"file": name, "error": err.Error()})
			continue
		}
		if info.Size() > artifacts.MaxBytesForCollection {
			continue
		}
		stamp := fileStamp{size: info.Size(), mtime: info.ModTime()}
		if prev, ok := seen[name]; ok && prev == stamp {
			continue
		}
		path := filepath.Join(s.workDir, name)
		body, err := os.ReadFile(path)
		if err != nil {
			s.log.Warn("live artifact sync: read failed", map[string]any{"file": name, "error": err.Error()})
			continue
		}
		kind := artifacts.KindTrajectory
		if filepath.Ext(name) == ".interp" {
			kind = artifacts.KindOther
		}
		art := artifacts.Artifact{
			Name:      name,
			Path:      path,
			Kind:      kind,
			SizeBytes: stamp.size,
			MTime:     stamp.mtime,
		}
		artifacts.AttachContent(&art, body)
		items = append(items, art)
		stamped[name] = stamp
	}
	if len(items) == 0 {
		return
	}
	upCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	if err := s.opts.Tracker.UpsertArtifacts(upCtx, s.runID, items); err != nil {
		// Leave `seen` unchanged for the failed files so the next tick retries.
		s.log.Warn("live artifact sync: upload failed", map[string]any{"error": err.Error()})
		return
	}
	for name, stamp := range stamped {
		seen[name] = stamp
	}
}
