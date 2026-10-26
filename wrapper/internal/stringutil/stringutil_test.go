package stringutil

import "testing"

func TestTruncateShortInputUnchanged(t *testing.T) {
	if got := Truncate([]byte("abc"), 5); got != "abc" {
		t.Fatalf("Truncate = %q, want %q", got, "abc")
	}
}

func TestTruncateExactLengthUnchanged(t *testing.T) {
	if got := Truncate([]byte("abcde"), 5); got != "abcde" {
		t.Fatalf("Truncate = %q, want %q", got, "abcde")
	}
}

func TestTruncateCutsAndMarks(t *testing.T) {
	if got := Truncate([]byte("abcdef"), 3); got != "abc"+Ellipsis {
		t.Fatalf("Truncate = %q, want %q", got, "abc"+Ellipsis)
	}
}

func TestTailShortInputUnchanged(t *testing.T) {
	if got := Tail("abc", 5); got != "abc" {
		t.Fatalf("Tail = %q, want %q", got, "abc")
	}
}

func TestTailCutsAndMarks(t *testing.T) {
	if got := Tail("abcdef", 3); got != Ellipsis+"def" {
		t.Fatalf("Tail = %q, want %q", got, Ellipsis+"def")
	}
}

func TestParseBool(t *testing.T) {
	for _, s := range []string{"1", "true", "YES", "on", " On "} {
		if v, ok := ParseBool(s); !v || !ok {
			t.Errorf("ParseBool(%q) = %v, %v; want true, true", s, v, ok)
		}
	}
	for _, s := range []string{"0", "false", "No", "off"} {
		if v, ok := ParseBool(s); v || !ok {
			t.Errorf("ParseBool(%q) = %v, %v; want false, true", s, v, ok)
		}
	}
	for _, s := range []string{"", "maybe", "2"} {
		if _, ok := ParseBool(s); ok {
			t.Errorf("ParseBool(%q) ok = true, want false", s)
		}
	}
}
