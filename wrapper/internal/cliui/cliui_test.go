package cliui

import (
	"bytes"
	"strings"
	"testing"
)

func TestErrorWritesMessage(t *testing.T) {
	var buf bytes.Buffer
	Error(&buf, "something broke", "try again")
	out := buf.String()
	if !strings.Contains(out, "something broke") {
		t.Fatalf("Error output missing message: %q", out)
	}
	if !strings.Contains(out, "try again") {
		t.Fatalf("Error output missing fix hint: %q", out)
	}
}

func TestWarningWritesMessage(t *testing.T) {
	var buf bytes.Buffer
	Warning(&buf, "heads up", "check logs")
	out := buf.String()
	if !strings.Contains(out, "heads up") {
		t.Fatalf("Warning output missing message: %q", out)
	}
}

func TestSuccessWritesMessage(t *testing.T) {
	var buf bytes.Buffer
	Success(&buf, "all good")
	out := buf.String()
	if !strings.Contains(out, "all good") {
		t.Fatalf("Success output missing message: %q", out)
	}
}

func TestHintWritesMessage(t *testing.T) {
	var buf bytes.Buffer
	Hint(&buf, "do this")
	out := buf.String()
	if !strings.Contains(out, "do this") {
		t.Fatalf("Hint output missing message: %q", out)
	}
}

func TestErrorNoFixOmitsHint(t *testing.T) {
	var buf bytes.Buffer
	Error(&buf, "oops", "")
	out := buf.String()
	if strings.Contains(out, "fix:") {
		t.Fatalf("Error with empty fix should not print 'fix:': %q", out)
	}
}
