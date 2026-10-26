package version

import (
	"strings"
	"testing"
)

func TestStringContainsVersion(t *testing.T) {
	s := String()
	if !strings.Contains(s, Version) {
		t.Fatalf("String() = %q, does not contain Version %q", s, Version)
	}
}

func TestStringContainsCommitAndDate(t *testing.T) {
	s := String()
	if !strings.Contains(s, "commit") {
		t.Fatalf("String() = %q, missing 'commit' label", s)
	}
	if !strings.Contains(s, "built") {
		t.Fatalf("String() = %q, missing 'built' label", s)
	}
}

func TestShortSHA(t *testing.T) {
	long := "abcdef1234567890abcdef"
	if got := shortSHA(long); len(got) != 12 {
		t.Fatalf("shortSHA(%q) = %q, want length 12", long, got)
	}
	short := "abc"
	if got := shortSHA(short); got != short {
		t.Fatalf("shortSHA(%q) = %q, want unchanged", short, got)
	}
}
