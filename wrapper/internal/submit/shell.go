package submit

import (
	"sort"
	"strings"
)

// shSafe are the characters a bare shell word may contain.
const shSafe = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./-"

// shQuote quotes a value for the generated shell script.
//
// Double quotes are preferred where they are safe, because that is how
// these arguments are written by hand (`orca x.inp "--bind-to none"`) and
// a generated script people read should look like the one they wrote.
// Anything the shell would still interpret inside double quotes falls
// back to single quotes.
func shQuote(s string) string {
	if s == "" {
		return `""`
	}
	if strings.IndexFunc(s, func(r rune) bool { return !strings.ContainsRune(shSafe, r) }) < 0 {
		return s
	}
	if !strings.ContainsAny(s, "\"$`\\!\n") {
		return `"` + s + `"`
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func quoteAll(xs []string) []string {
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		out = append(out, shQuote(x))
	}
	return out
}

// shQuoteAll renders a list as space-separated shell words. Globs need
// no special case: `*`, `?` and `[` are outside shSafe, so shQuote always
// quotes a pattern (double quotes when nothing else needs escaping,
// single quotes when the value also carries `$`, a backtick or friends).
// Either way the pattern reaches the helper loop that expands it — with
// scratch as the working directory — instead of being expanded once, at
// script-generation time, against the wrong directory. The previous
// hand-rolled `"`+x+`"` branch left `$(...)` and backticks live inside
// the double quotes.
func shQuoteAll(xs []string) string {
	return strings.Join(quoteAll(xs), " ")
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
