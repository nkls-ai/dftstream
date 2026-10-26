package restart

import "testing"

func TestImagModesInLastFreqSectionUsesLastSectionOnly(t *testing.T) {
	// A stale Recalc_Hess section with an imaginary mode, then a clean
	// final section — the stale entry must not leak in.
	out := `
VIBRATIONAL FREQUENCIES
   6:      -321.00 cm**-1 ***imaginary mode***
some other text
VIBRATIONAL FREQUENCIES
   6:       123.45 cm**-1
   7:       234.56 cm**-1
`
	if modes := ImagModesInLastFreqSection(out); len(modes) != 0 {
		t.Fatalf("modes = %+v, want none (stale section must be ignored)", modes)
	}
}

func TestImagModesInLastFreqSectionFindsImaginaries(t *testing.T) {
	out := `
VIBRATIONAL FREQUENCIES
   0:         0.00 cm**-1
   6:      -123.45 cm**-1 ***imaginary mode***
   7:       234.56 cm**-1
`
	modes := ImagModesInLastFreqSection(out)
	if len(modes) != 1 || modes[0].Index != 6 || modes[0].FreqCM != -123.45 {
		t.Fatalf("modes = %+v, want one entry {6 -123.45}", modes)
	}
}

func TestImagModesInLastFreqSectionNegativeWithoutMarker(t *testing.T) {
	// A negative wavenumber is physically imaginary even if the marker is
	// missing — the extractor accepts either signal.
	out := "VIBRATIONAL FREQUENCIES\n   6:      -50.00 cm**-1\n"
	modes := ImagModesInLastFreqSection(out)
	if len(modes) != 1 || modes[0].Index != 6 {
		t.Fatalf("modes = %+v, want one entry for mode 6", modes)
	}
}

func TestImagModesInLastFreqSectionAbsent(t *testing.T) {
	if modes := ImagModesInLastFreqSection("no frequencies here"); modes != nil {
		t.Fatalf("modes = %+v, want nil", modes)
	}
}
