package inputbuild

import (
	"fmt"
	"strings"
)

// Atom is one cartesian coordinate row (Ångström).
type Atom struct {
	El      string
	X, Y, Z float64
}

// Structure is the coordinate specification of an input: either an
// inline block or a reference to an external .xyz.
type Structure interface {
	// Render emits the complete coordinate section, newline-terminated.
	Render(env Environment) string
}

// Geometry is an inline `* xyz CHARGE MULT … *` coordinate block.
type Geometry []Atom

// Render implements Structure.
func (g Geometry) Render(env Environment) string {
	var b strings.Builder
	fmt.Fprintf(&b, "* xyz %d %d\n", env.Charge, env.Mult)
	for _, at := range g {
		b.WriteString(AtomLine(at))
	}
	b.WriteString("*\n")
	return b.String()
}

// XYZFile references an external .xyz file (`* xyzfile CHARGE MULT f`).
// Required for NEB: ORCA's band code aborts ("GBW-File <base>_im<N>.gbw
// not found") when the starting structure is given inline.
type XYZFile string

// Render implements Structure.
func (f XYZFile) Render(env Environment) string {
	return fmt.Sprintf("* xyzfile %d %d %s\n", env.Charge, env.Mult, string(f))
}

// AtomLine formats one coordinate row. The column layout is shared by
// generated inputs and generated .xyz files so both read identically.
func AtomLine(at Atom) string {
	return fmt.Sprintf("%-3s %14.8f %14.8f %14.8f\n", at.El, at.X, at.Y, at.Z)
}

// XYZFileText renders a standalone .xyz file (count + comment + atoms).
func XYZFileText(comment string, geom []Atom) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d\n%s\n", len(geom), comment)
	for _, at := range geom {
		b.WriteString(AtomLine(at))
	}
	return b.String()
}
