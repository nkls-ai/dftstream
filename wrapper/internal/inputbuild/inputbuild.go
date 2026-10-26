// Package inputbuild is the typed representation of an ORCA input file
// and its single renderer.
//
// Everything that writes an ORCA input — restart, the follow-up
// generators, the UI's input builder — describes the job as an Input
// value (job keywords, environment, resources, typed blocks, structure)
// and lets Render() produce the bytes. Before this package the same
// layout was re-derived by hand with fmt.Sprintf at every call site,
// which is how generated inputs silently drift apart.
//
// The rendered layout is a hard contract: these files are submitted to
// real clusters, and the golden tests in internal/restart and
// internal/followup pin it byte for byte.
//
//	# comment lines (provenance)
//	! KEYWORD KEYWORD …
//	%pal nprocs N end          (omitted when unset)
//	%maxcore M                 (omitted when unset)
//	<blocks, in order>
//	* xyz CHARGE MULT          | * xyzfile CHARGE MULT file.xyz
//	El   x   y   z
//	*
package inputbuild

import (
	"fmt"
	"strings"
)

// Input is one complete ORCA input file.
type Input struct {
	// Comments are rendered verbatim above everything else, each
	// newline-terminated (the provenance line is one).
	Comments []string
	// Keywords are the '!' line tokens in their original casing.
	Keywords []string
	Env      Environment
	Res      Resources
	// Blocks render after the resource lines, in order.
	Blocks []Block
	// Structure is the coordinate specification. A nil Structure renders
	// no coordinate section at all (an input fragment).
	Structure Structure
}

// Render produces the input file text.
func (in Input) Render() string {
	var b strings.Builder
	for _, c := range in.Comments {
		b.WriteString(c)
		writeNewlineIfMissing(&b, c)
	}
	fmt.Fprintf(&b, "! %s\n", strings.Join(in.Keywords, " "))
	b.WriteString(in.Res.Render())
	for _, blk := range in.Blocks {
		text := blk.Render()
		if text == "" {
			continue
		}
		b.WriteString(text)
		writeNewlineIfMissing(&b, text)
	}
	if in.Structure != nil {
		b.WriteString(in.Structure.Render(in.Env))
	}
	return b.String()
}

func writeNewlineIfMissing(b *strings.Builder, s string) {
	if !strings.HasSuffix(s, "\n") {
		b.WriteString("\n")
	}
}
