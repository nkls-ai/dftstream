package inputbuild

import (
	"fmt"
	"strings"
)

// Block is one `%name … end` section of an input.
type Block interface {
	// Render returns the block text. A missing trailing newline is added
	// by the renderer, so both one-line and multi-line forms are fine.
	Render() string
}

// RawBlock is block text supplied verbatim. It exists for the ORCA
// corners that have no typed representation yet (and for the UI's
// hand-edited input); prefer a typed block wherever one exists.
type RawBlock string

// Render implements Block.
func (r RawBlock) Render() string { return string(r) }

// blockText renders `%name` + one indented line per entry + `end`.
// Empty entries are skipped so an unset field never emits a blank line.
func blockText(name string, entries ...string) string {
	var b strings.Builder
	b.WriteString("%" + name + "\n")
	for _, e := range entries {
		if e == "" {
			continue
		}
		b.WriteString("  " + e + "\n")
	}
	b.WriteString("end")
	return b.String()
}

// NEBBlock is the `%neb` section of a nudged-elastic-band run. The final
// endpoint always travels as an external .xyz — ORCA's band code needs a
// file, not an inline structure.
type NEBBlock struct {
	// EndXYZFile is the product-side endpoint file (basename).
	EndXYZFile string
	NImages    int
	// TSXYZFile optionally seeds the band with a TS guess.
	TSXYZFile string
}

// DefaultNEBImages is ORCA's practical default band size for a first
// NEB-TS attempt.
const DefaultNEBImages = 8

// Render implements Block.
func (n NEBBlock) Render() string {
	entries := []string{fmt.Sprintf("NEB_End_XYZFile %q", n.EndXYZFile)}
	if n.TSXYZFile != "" {
		entries = append(entries, fmt.Sprintf("NEB_TS_XYZFile %q", n.TSXYZFile))
	}
	images := n.NImages
	if images <= 0 {
		images = DefaultNEBImages
	}
	entries = append(entries, fmt.Sprintf("Nimages %d", images))
	return blockText("neb", entries...)
}

// IRCBlock is the `%irc` section. Reading the parent TS Hessian is the
// whole point of generating one: without it ORCA recomputes a Hessian
// before the IRC, which costs as much as the TS search did.
type IRCBlock struct {
	// HessFilename, when set, makes the IRC read that Hessian
	// (`InitHess Read`) instead of computing a fresh one.
	HessFilename string
	// MaxIter caps the IRC steps per direction; 0 leaves ORCA's default.
	MaxIter int
}

// Render implements Block.
func (i IRCBlock) Render() string {
	var entries []string
	if i.HessFilename != "" {
		entries = append(entries,
			"InitHess Read",
			fmt.Sprintf("Hess_Filename %q", i.HessFilename))
	}
	if i.MaxIter > 0 {
		entries = append(entries, fmt.Sprintf("MaxIter %d", i.MaxIter))
	}
	if len(entries) == 0 {
		return ""
	}
	return blockText("irc", entries...)
}

// ScanCoord is the kind of internal coordinate a relaxed scan drives,
// spelled the way ORCA's `%geom Scan` section expects it.
type ScanCoord string

const (
	// ScanBond drives a bond length between two atoms (Å).
	ScanBond ScanCoord = "B"
	// ScanAngle drives an angle over three atoms (degrees).
	ScanAngle ScanCoord = "A"
	// ScanDihedral drives a dihedral over four atoms (degrees).
	ScanDihedral ScanCoord = "D"
)

// ScanAtomCount returns how many atom indices the coordinate kind takes;
// ok is false for a kind this package does not know.
func ScanAtomCount(c ScanCoord) (int, bool) {
	switch c {
	case ScanBond:
		return 2, true
	case ScanAngle:
		return 3, true
	case ScanDihedral:
		return 4, true
	}
	return 0, false
}

// ScanDimension is one driven coordinate of a relaxed scan:
// `B 0 1 = 1.10, 1.80, 15` — coordinate, 0-based atom indices, range
// endpoints and the number of scan points.
type ScanDimension struct {
	Coord ScanCoord
	// Atoms are ORCA's 0-based atom indices (2 for B, 3 for A, 4 for D).
	Atoms []int
	From  float64
	To    float64
	Steps int
}

// Render emits the scan entry line ("B 0 1 = 1.10, 1.80, 15").
func (s ScanDimension) Render() string {
	idx := make([]string, len(s.Atoms))
	for i, a := range s.Atoms {
		idx[i] = fmt.Sprintf("%d", a)
	}
	return fmt.Sprintf("%s %s = %s, %s, %d",
		string(s.Coord), strings.Join(idx, " "),
		trimFloat(s.From), trimFloat(s.To), s.Steps)
}

// trimFloat formats a scan endpoint with two decimals minimum but no
// trailing noise beyond what the user asked for (1.1 → "1.10",
// 109.471 → "109.471"), so generated inputs read like hand-written ones.
func trimFloat(v float64) string {
	s := fmt.Sprintf("%.6f", v)
	s = strings.TrimRight(s, "0")
	// Keep at least two decimals: "1." → "1.00", "1.1" → "1.10".
	dot := strings.IndexByte(s, '.')
	for len(s)-dot-1 < 2 {
		s += "0"
	}
	return s
}

// GeomBlock is the `%geom` section: the optimizer's own knobs.
type GeomBlock struct {
	// CalcHess requests an exact initial Hessian — the stabilizer for a
	// saddle search that lost its NEB context.
	CalcHess bool
	// MaxIter caps optimization cycles; 0 leaves ORCA's default.
	MaxIter int
	// Constraints are raw `%geom Constraints` entries ({B 0 1 C}, …).
	Constraints []string
	// Scans are the driven coordinates of a relaxed surface scan.
	Scans []ScanDimension
}

// Render implements Block.
func (g GeomBlock) Render() string {
	var entries []string
	if g.CalcHess {
		entries = append(entries, "Calc_Hess true")
	}
	if g.MaxIter > 0 {
		entries = append(entries, fmt.Sprintf("MaxIter %d", g.MaxIter))
	}
	if len(g.Scans) > 0 {
		entries = append(entries, "Scan")
		for _, s := range g.Scans {
			entries = append(entries, "  "+s.Render())
		}
		entries = append(entries, "end")
	}
	if len(g.Constraints) > 0 {
		entries = append(entries, "Constraints")
		for _, c := range g.Constraints {
			entries = append(entries, "  "+c)
		}
		entries = append(entries, "end")
	}
	if len(entries) == 0 {
		return ""
	}
	return blockText("geom", entries...)
}

// TDDFTBlock is the `%tddft` section of an absorption calculation: how
// many excited states to solve for, and whether triplets are included.
type TDDFTBlock struct {
	// NRoots is the number of excited states; the block renders nothing
	// without one (a bare %tddft block is not a meaningful request).
	NRoots int
	// Triplets additionally computes triplet states.
	Triplets bool
}

// Render implements Block.
func (t TDDFTBlock) Render() string {
	if t.NRoots <= 0 {
		return ""
	}
	entries := []string{fmt.Sprintf("NRoots %d", t.NRoots)}
	if t.Triplets {
		entries = append(entries, "Triplets true")
	}
	return blockText("tddft", entries...)
}

// MECPBlock is the `%mecp` section: the spin multiplicity of the second
// surface. The first surface's multiplicity is the input's own (the
// coordinate header), exactly how ORCA reads a crossing-point search —
// and how the viewer's MECP tab labels state 1 / state 2.
type MECPBlock struct {
	// Mult2 is the second surface's multiplicity (2S+1); the block
	// renders nothing without one.
	Mult2 int
}

// Render implements Block.
func (m MECPBlock) Render() string {
	if m.Mult2 <= 0 {
		return ""
	}
	return blockText("mecp", fmt.Sprintf("Mult %d", m.Mult2))
}

// FreqBlock is the `%freq` section's thermochemistry conditions. ORCA's
// own defaults are 298.15 K and 1 atm; an unset (non-positive) field is
// omitted so the defaults stay ORCA's, not ours.
type FreqBlock struct {
	// TemperatureK is the thermochemistry temperature (Kelvin).
	TemperatureK float64
	// PressureAtm is the thermochemistry pressure (atm).
	PressureAtm float64
}

// Render implements Block.
func (f FreqBlock) Render() string {
	var entries []string
	if f.TemperatureK > 0 {
		entries = append(entries, fmt.Sprintf("Temp %s", trimFloat(f.TemperatureK)))
	}
	if f.PressureAtm > 0 {
		entries = append(entries, fmt.Sprintf("Pressure %s", trimFloat(f.PressureAtm)))
	}
	if len(entries) == 0 {
		return ""
	}
	return blockText("freq", entries...)
}

// SCFBlock is the `%scf` section.
type SCFBlock struct {
	// MaxIter caps SCF cycles; 0 leaves ORCA's default.
	MaxIter int
}

// Render implements Block.
func (s SCFBlock) Render() string {
	if s.MaxIter <= 0 {
		return ""
	}
	return blockText("scf", fmt.Sprintf("MaxIter %d", s.MaxIter))
}

// CPCMBlock is the `%cpcm` section, used when a solvent needs explicit
// parameters (SMD's solvent name lives here, not on the '!' line, when
// the model is driven manually).
type CPCMBlock struct {
	SMD bool
	// SMDSolvent is the solvent name for the SMD parameterization.
	SMDSolvent string
}

// Render implements Block.
func (c CPCMBlock) Render() string {
	var entries []string
	if c.SMD {
		entries = append(entries, "SMD true")
	}
	if c.SMDSolvent != "" {
		entries = append(entries, fmt.Sprintf("SMDsolvent %q", c.SMDSolvent))
	}
	if len(entries) == 0 {
		return ""
	}
	return blockText("cpcm", entries...)
}
