// Package stringutil holds tiny string helpers shared across packages.
package stringutil

import "strings"

// Ellipsis marks truncated text. ASCII (not U+2026) so truncated error
// messages and logs render identically in any terminal or log store.
const Ellipsis = "..."

// Truncate returns b as a string, cut to at most n bytes with an
// ellipsis appended when anything was dropped.
func Truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + Ellipsis
}

// Tail returns the last n bytes of s, with an ellipsis prepended when
// anything was dropped. Used to surface the interesting end of a tool's
// combined output in error messages.
func Tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return Ellipsis + s[len(s)-n:]
}

// ParseBool parses the on/off spellings DFTStream accepts in flags and
// environment variables, case-insensitively and ignoring surrounding
// space: 1/true/yes/on and 0/false/no/off. ok is false for anything else
// (including ""), leaving the caller to decide what an unknown value means.
func ParseBool(s string) (value, ok bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true, true
	case "0", "false", "no", "off":
		return false, true
	default:
		return false, false
	}
}
