package submit

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Dep is one file an input pulls in from its own directory.
type Dep struct {
	Name string // as written in the input
	Kind DepKind
}

// depRE matches a filename with one of the dependency extensions.
// Quotes are not part of the character class, so the quoted spellings
// ORCA blocks use (`Hess_Filename "x.hess"`, `%moinp "y.gbw"`) fall out
// for free, as does the bare `* xyzfile 0 1 z.xyz`.
//
// inputparse deliberately models the '!' keyword line and the %pal /
// %maxcore / charge-mult blocks, not the free-form filename arguments
// scattered across %geom, %moinp, %neb and %irc; there is no reference
// list there to reuse, so the scan happens here.
var depRE = buildDepRE()

func buildDepRE() *regexp.Regexp {
	exts := make([]string, 0, len(depKinds))
	for _, k := range depKinds {
		exts = append(exts, string(k))
	}
	// depKinds is ordered longest-first so `.allxyz` wins over `.xyz`.
	// `/` is inside the class on purpose: a reference with a directory
	// component must be caught and reported, not silently truncated to
	// its basename and staged from the wrong file.
	return regexp.MustCompile(`(?i)[\w./\-]*[\w.\-]\.(?:` + strings.Join(exts, "|") + `)\b`)
}

// ScanDeps lists the files an input references, in first-seen order and
// without duplicates.
func ScanDeps(text string) []Dep {
	var out []Dep
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		for _, name := range depRE.FindAllString(stripComment(line), -1) {
			if seen[name] {
				continue
			}
			seen[name] = true
			out = append(out, Dep{Name: name, Kind: kindOf(name)})
		}
	}
	return out
}

// stripComment drops an ORCA end-of-line comment (`#`), so a commented-
// out geometry line does not drag a file into the job directory.
func stripComment(line string) string {
	if i := strings.Index(line, "#"); i >= 0 {
		return line[:i]
	}
	return line
}

func kindOf(name string) DepKind {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	for _, k := range depKinds {
		if string(k) == ext {
			return k
		}
	}
	return ""
}

// resolveDeps checks every referenced file exists next to the input.
//
// A missing dependency is fatal: ORCA would sit in the queue for hours
// and then abort on its first read, which is exactly the wait this
// command exists to save. The exception is a file the run produces for
// itself (a restart reading back its own <stem>.gbw or <stem>.hess).
func resolveDeps(dir, stem string, deps []Dep) ([]Dep, error) {
	var out []Dep
	var missing, nested []string
	for _, d := range deps {
		if strings.ContainsRune(d.Name, '/') {
			nested = append(nested, d.Name)
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, d.Name)); err != nil {
			if strings.TrimSuffix(d.Name, filepath.Ext(d.Name)) == stem {
				continue // produced by this run in its own directory
			}
			missing = append(missing, d.Name)
			continue
		}
		out = append(out, d)
	}
	if len(nested) > 0 {
		return nil, fmt.Errorf(
			"referenced file(s) carry a directory path: %s — ORCA resolves these against its working directory, "+
				"so copy them next to the input and reference them by name",
			strings.Join(nested, ", "))
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("referenced file(s) not found in %s: %s", dir, strings.Join(missing, ", "))
	}
	return out, nil
}
