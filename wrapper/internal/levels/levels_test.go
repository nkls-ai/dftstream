package levels

import "testing"

func TestParseOrbitalMode(t *testing.T) {
	cases := []struct {
		in   string
		want OrbitalMode
	}{
		{"", OrbitalsFinal},
		{"final", OrbitalsFinal},
		{"end", OrbitalsFinal},
		{"none", OrbitalsNone},
		{"off", OrbitalsNone},
		{"0", OrbitalsNone},
		{"per-cycle", OrbitalsPerCycle},
		{"percycle", OrbitalsPerCycle},
		{"all", OrbitalsPerCycle},
		{"cycle", OrbitalsPerCycle},
		{"  Final ", OrbitalsFinal}, // case/space tolerant, like ParseArtifactLevel
	}
	for _, c := range cases {
		got, err := ParseOrbitalMode(c.in)
		if err != nil {
			t.Errorf("ParseOrbitalMode(%q) error: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("ParseOrbitalMode(%q) = %s, want %s", c.in, got, c.want)
		}
	}
	if _, err := ParseOrbitalMode("bogus"); err == nil {
		t.Error("ParseOrbitalMode(bogus) succeeded, want error")
	}
}

func TestParseArtifactLevel(t *testing.T) {
	cases := map[string]ArtifactLevel{
		"": ArtifactsMedium, "medium": ArtifactsMedium,
		"none": ArtifactsNone, "off": ArtifactsNone, "0": ArtifactsNone,
		"io": ArtifactsIO, "input-output": ArtifactsIO, "input-output-only": ArtifactsIO,
		"essential": ArtifactsEssential, "min": ArtifactsEssential, "minimal": ArtifactsEssential,
		"all": ArtifactsAll, "max": ArtifactsAll, " ALL ": ArtifactsAll,
	}
	for in, want := range cases {
		got, err := ParseArtifactLevel(in)
		if err != nil || got != want {
			t.Errorf("ParseArtifactLevel(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	if _, err := ParseArtifactLevel("bogus"); err == nil {
		t.Error("ParseArtifactLevel(bogus) succeeded, want error")
	}
}

// String is the wire spelling (batch artifactLevel); it must round-trip.
func TestArtifactLevelStringRoundTrips(t *testing.T) {
	for l := ArtifactsNone; l <= ArtifactsAll; l++ {
		got, err := ParseArtifactLevel(l.String())
		if err != nil || got != l {
			t.Errorf("ParseArtifactLevel(%q) = %v, %v; want %v", l.String(), got, err, l)
		}
	}
}
