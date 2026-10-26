package logging

import (
	"context"
	"testing"

	"github.com/nkls-ai/dftstream/internal/tracker"
)

type logRecorder struct {
	tracker.NoopTracker
	logs []tracker.LogEntry
}

func (r *logRecorder) AppendLogs(_ context.Context, _ tracker.RunID, entries []tracker.LogEntry) error {
	r.logs = append(r.logs, entries...)
	return nil
}

func TestTrackerSinkWritesEntriesToTracker(t *testing.T) {
	rec := &logRecorder{}
	sink := &TrackerSink{Tracker: rec, RunID: "run-1"}
	log := New(LevelDebug, sink)
	log.SetStderr(nil)

	log.Info("hello")
	log.Warn("warning", map[string]any{"code": 99})

	if err := log.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(rec.logs) != 2 {
		t.Fatalf("got %d logs, want 2", len(rec.logs))
	}
	if rec.logs[0].Level != "info" || rec.logs[0].Message != "hello" {
		t.Errorf("logs[0] = %+v", rec.logs[0])
	}
	if rec.logs[1].Fields["code"] != 99 {
		t.Errorf("logs[1].Fields = %v", rec.logs[1].Fields)
	}
}

func TestTrackerSinkSkipsWhenNoRunID(t *testing.T) {
	rec := &logRecorder{}
	sink := &TrackerSink{Tracker: rec, RunID: ""}
	log := New(LevelDebug, sink)
	log.SetStderr(nil)

	log.Info("orphan")
	if err := log.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(rec.logs) != 0 {
		t.Fatalf("expected 0 logs when RunID is empty, got %d", len(rec.logs))
	}
}

func TestTrackerSinkSkipsWhenNilTracker(t *testing.T) {
	sink := &TrackerSink{Tracker: nil, RunID: "run-1"}
	log := New(LevelDebug, sink)
	log.SetStderr(nil)

	log.Info("orphan")
	if err := log.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestTrackerSinkSystemInfoEntriesFlush(t *testing.T) {
	rec := &logRecorder{}
	sink := &TrackerSink{Tracker: rec, RunID: "run-1"}
	log := New(LevelError, sink)
	log.SetStderr(nil)

	log.SystemInfo("system env", map[string]any{"os": "linux"})

	if err := log.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(rec.logs) != 1 {
		t.Fatalf("got %d logs, want 1 (SystemInfo bypasses level)", len(rec.logs))
	}
	if rec.logs[0].Message != "system env" {
		t.Errorf("message = %q", rec.logs[0].Message)
	}
}
