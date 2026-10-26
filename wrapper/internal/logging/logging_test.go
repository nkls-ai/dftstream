package logging

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestLevelFiltering(t *testing.T) {
	log := New(LevelWarn)
	log.SetStderr(nil)

	log.Debug("debug msg")
	log.Info("info msg")
	log.Warn("warn msg")
	log.Error("error msg")

	entries := log.Entries()
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries (warn+error), got %d", len(entries))
	}
	if entries[0].Message != "warn msg" {
		t.Errorf("entries[0] = %q, want 'warn msg'", entries[0].Message)
	}
	if entries[1].Message != "error msg" {
		t.Errorf("entries[1] = %q, want 'error msg'", entries[1].Message)
	}
}

func TestSystemInfoBypassesLevel(t *testing.T) {
	log := New(LevelError)
	log.SetStderr(nil)

	log.SystemInfo("startup", map[string]any{"os": "linux"})
	log.Info("regular info")

	entries := log.Entries()
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry (SystemInfo bypasses level), got %d", len(entries))
	}
	if entries[0].Message != "startup" {
		t.Errorf("entry = %q, want 'startup'", entries[0].Message)
	}
}

func TestFieldsAttached(t *testing.T) {
	log := New(LevelDebug)
	log.SetStderr(nil)

	log.Error("fail", map[string]any{"code": 42, "path": "/tmp/x"})

	entries := log.Entries()
	if len(entries) != 1 {
		t.Fatal("expected 1 entry")
	}
	if entries[0].Fields["code"] != 42 {
		t.Errorf("field code = %v, want 42", entries[0].Fields["code"])
	}
}

func TestStderrOutput(t *testing.T) {
	var buf bytes.Buffer
	log := New(LevelInfo)
	log.SetStderr(&buf)

	log.Info("hello world")

	out := buf.String()
	if !strings.Contains(out, "[dftstream") {
		t.Errorf("stderr missing prefix: %q", out)
	}
	if !strings.Contains(out, "hello world") {
		t.Errorf("stderr missing message: %q", out)
	}
	if !strings.Contains(out, "info") {
		t.Errorf("stderr missing level: %q", out)
	}
}

type recordingSink struct {
	entries []Entry
}

func (r *recordingSink) WriteEntries(_ context.Context, entries []Entry) error {
	r.entries = append(r.entries, entries...)
	return nil
}

func TestFlushSendsToSink(t *testing.T) {
	sink := &recordingSink{}
	log := New(LevelDebug, sink)
	log.SetStderr(nil)

	log.Info("one")
	log.Warn("two")

	if err := log.Flush(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(sink.entries) != 2 {
		t.Fatalf("sink got %d entries, want 2", len(sink.entries))
	}

	remaining := log.Entries()
	if len(remaining) != 0 {
		t.Fatalf("buffer not cleared after flush: %d entries remain", len(remaining))
	}
}

func TestParseLevelValid(t *testing.T) {
	cases := []struct {
		input string
		want  Level
	}{
		{"debug", LevelDebug},
		{"INFO", LevelInfo},
		{"warn", LevelWarn},
		{"error", LevelError},
		{"", LevelWarn},
		{"Warning", LevelWarn},
	}
	for _, c := range cases {
		got, err := ParseLevel(c.input)
		if err != nil {
			t.Errorf("ParseLevel(%q) error: %v", c.input, err)
		}
		if got != c.want {
			t.Errorf("ParseLevel(%q) = %v, want %v", c.input, got, c.want)
		}
	}
}

func TestParseLevelInvalid(t *testing.T) {
	_, err := ParseLevel("banana")
	if err == nil {
		t.Fatal("ParseLevel(banana) should error")
	}
}

func TestLevelOffDisablesEverything(t *testing.T) {
	var buf bytes.Buffer
	log := New(LevelOff)
	log.SetStderr(&buf)

	log.Debug("d")
	log.Info("i")
	log.Warn("w")
	log.Error("e")
	log.SystemInfo("sys", map[string]any{"k": "v"})

	if len(log.Entries()) != 0 {
		t.Fatalf("expected 0 entries with LevelOff, got %d", len(log.Entries()))
	}
	if buf.Len() != 0 {
		t.Fatalf("expected no stderr output with LevelOff, got %q", buf.String())
	}
}

func TestParseLevelOff(t *testing.T) {
	for _, s := range []string{"off", "none"} {
		got, err := ParseLevel(s)
		if err != nil {
			t.Errorf("ParseLevel(%q) error: %v", s, err)
		}
		if got != LevelOff {
			t.Errorf("ParseLevel(%q) = %v, want LevelOff", s, got)
		}
	}
}
