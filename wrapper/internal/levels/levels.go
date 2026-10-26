// Package levels defines the two tracking knobs shared by `dftstream run`
// and the `dftstream submit` cluster config: how many artifacts to upload
// and how many orbital cubes to render. It is a leaf package (stdlib only)
// so the config loader can validate spellings without importing the runner.
package levels

import (
	"fmt"
	"strings"
)

// ArtifactLevel controls how much of the run directory is collected.
//
//	ArtifactsNone:      nothing (skip artifact upload entirely)
//	ArtifactsIO:        .inp, .out, stdout
//	ArtifactsEssential: input/output + .xyz, .allxyz
//	ArtifactsMedium:    essential + .property.txt/.property.json, .bibtex,
//	                    .log, .property
//	ArtifactsAll:       medium + everything else known to ORCA EXCEPT heavy
//	                    binaries (.gbw, .densities, …) and oversize files.
//
// The levels are ordered: a file is collected when the requested level is
// at least the level its extension requires.
type ArtifactLevel int

const (
	ArtifactsNone ArtifactLevel = iota
	ArtifactsIO
	ArtifactsEssential
	ArtifactsMedium
	ArtifactsAll
)

// ArtifactLevelHelp lists the canonical spellings, for usage/error text.
const ArtifactLevelHelp = "none|io|essential|medium|all"

// ParseArtifactLevel parses a level name as used by the CLI, the
// environment and the submit cluster config, accepting the historical
// aliases. Empty string returns the default (ArtifactsMedium).
func ParseArtifactLevel(s string) (ArtifactLevel, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "medium":
		return ArtifactsMedium, nil
	case "none", "off", "0":
		return ArtifactsNone, nil
	case "io", "input-output", "input-output-only":
		return ArtifactsIO, nil
	case "essential", "min", "minimal":
		return ArtifactsEssential, nil
	case "all", "max":
		return ArtifactsAll, nil
	default:
		return ArtifactsMedium, fmt.Errorf("unknown artifact level %q (use %s)", s, ArtifactLevelHelp)
	}
}

// String returns the canonical spelling; it is what crosses the wire
// (batch artifactLevel, session log) and what `dftstream run` accepts.
func (l ArtifactLevel) String() string {
	switch l {
	case ArtifactsNone:
		return "none"
	case ArtifactsIO:
		return "io"
	case ArtifactsEssential:
		return "essential"
	case ArtifactsMedium:
		return "medium"
	case ArtifactsAll:
		return "all"
	default:
		return "unknown"
	}
}

// UnmarshalText lets YAML/JSON configs name a level with any spelling
// ParseArtifactLevel accepts.
func (l *ArtifactLevel) UnmarshalText(b []byte) error {
	v, err := ParseArtifactLevel(string(b))
	if err != nil {
		return err
	}
	*l = v
	return nil
}

// OrbitalMode selects how much post-processing the wrapper does to expose
// HOMO/LUMO isosurfaces in the UI.
type OrbitalMode string

const (
	// OrbitalsNone disables orca_plot entirely.
	OrbitalsNone OrbitalMode = "none"
	// OrbitalsFinal generates cubes for the converged wavefunction only.
	OrbitalsFinal OrbitalMode = "final"
	// OrbitalsPerCycle snapshots the .gbw after each SCF convergence
	// during a geometry optimization and emits HOMO/LUMO cubes for every
	// cycle. Lets the UI swap orbitals as the structure scrubs.
	OrbitalsPerCycle OrbitalMode = "per-cycle"
)

// OrbitalModeHelp lists the canonical spellings, for usage/error text.
const OrbitalModeHelp = "none|final|per-cycle"

func (m OrbitalMode) String() string { return string(m) }

// ParseOrbitalMode parses an orbital-mode name as used by the CLI, the
// environment and the submit cluster config, accepting the historical
// aliases. Empty string returns the default (OrbitalsFinal).
func ParseOrbitalMode(s string) (OrbitalMode, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "final", "end":
		return OrbitalsFinal, nil
	case "none", "off", "0":
		return OrbitalsNone, nil
	case "per-cycle", "percycle", "all", "cycle":
		return OrbitalsPerCycle, nil
	default:
		return OrbitalsFinal, fmt.Errorf("unknown orbital mode %q (use %s)", s, OrbitalModeHelp)
	}
}

// UnmarshalText lets YAML/JSON configs name a mode with any spelling
// ParseOrbitalMode accepts; the stored value is always canonical.
func (m *OrbitalMode) UnmarshalText(b []byte) error {
	v, err := ParseOrbitalMode(string(b))
	if err != nil {
		return err
	}
	*m = v
	return nil
}
