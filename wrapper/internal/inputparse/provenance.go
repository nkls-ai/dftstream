package inputparse

import (
	"fmt"
	"regexp"
)

// Provenance links a generated input back to the run it was derived from.
// It travels as an ORCA-inert `#` comment at the top of the input
// (`# dftstream: edge=<kind> parent="<experiment>/<run>"`); the wrapper
// resolves it to a run id at submit time to record the lineage edge.
type Provenance struct {
	// Edge is the follow-up kind: neb-ts | irc | endpoint-opt | sp | restart.
	Edge string
	// ParentExp / ParentRun name the parent under the same defaults
	// `dftstream run` derives from a path (directory name / file stem).
	ParentExp string
	ParentRun string
}

// Comment renders the provenance line, newline-terminated.
func (p Provenance) Comment() string {
	return fmt.Sprintf("# dftstream: edge=%s parent=%q\n", p.Edge, p.ParentExp+"/"+p.ParentRun)
}

// Inputs generated before the rename from OrcaStream carry `# orcastream:`;
// they are still recognized so their lineage is not lost.
var reProvenance = regexp.MustCompile(`(?m)^#\s*(?:dftstream|orcastream):\s*edge=(\S+)\s+parent="([^"/]+)/([^"]+)"`)

// ParseProvenance extracts the first provenance comment from an input
// text; ok is false when none is present.
func ParseProvenance(text string) (Provenance, bool) {
	m := reProvenance.FindStringSubmatch(text)
	if m == nil {
		return Provenance{}, false
	}
	return Provenance{Edge: m[1], ParentExp: m[2], ParentRun: m[3]}, true
}
