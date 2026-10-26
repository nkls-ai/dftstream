package restart

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/inputparse"
)

const imagRunOut = `Program Version 6.1.0
---------------------------------
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  O     0.000000    0.000000    0.000000
  H     0.000000    0.000000    0.960000
  H     0.930000    0.000000   -0.240000

                    ***        THE OPTIMIZATION HAS CONVERGED     ***

---------------------------------
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
  O     0.000000    0.000000    0.010000
  H     0.000000    0.000000    0.970000
  H     0.940000    0.000000   -0.230000

-----------------------
VIBRATIONAL FREQUENCIES
-----------------------

     6:      -65.98 cm**-1  ***imaginary mode***
     7:     1602.34 cm**-1

------------
NORMAL MODES
------------

These modes are the cartesian displacements

                  6          7
      0       0.100000   0.000000
      1       0.000000   0.010000
      2       0.000000   0.020000
      3      -0.050000   0.030000
      4       0.000000   0.040000
      5       0.000000   0.050000
      6      -0.050000   0.060000
      7       0.000000   0.070000
      8       0.000000   0.080000

-----------
IR SPECTRUM
-----------

TOTAL RUN TIME: 0 days 0 hours 0 minutes 42 seconds 128 msec
                             ****ORCA TERMINATED NORMALLY****
`

func TestAnalyzeImagRun(t *testing.T) {
	a := AnalyzeOutput(imagRunOut)
	if !a.Terminated || !a.OptConverged {
		t.Fatalf("terminated=%v converged=%v, want both true", a.Terminated, a.OptConverged)
	}
	if len(a.ImagModes) != 1 || a.ImagModes[0].Index != 6 {
		t.Fatalf("ImagModes = %+v, want one entry for mode 6", a.ImagModes)
	}
	// Last geometry block wins.
	if len(a.LastGeometry) != 3 || a.LastGeometry[0].Z != 0.010000 {
		t.Fatalf("LastGeometry = %+v, want the second block", a.LastGeometry)
	}
	vec, ok := a.NormalModes[6]
	if !ok || len(vec) != 9 {
		t.Fatalf("NormalModes[6] = %v (ok=%v), want 9 components", vec, ok)
	}
	if vec[0] != 0.1 || vec[3] != -0.05 {
		t.Fatalf("NormalModes[6] = %v, wrong values", vec)
	}
}

func TestClassifyMatrix(t *testing.T) {
	cases := []struct {
		name             string
		term, conv       bool
		imag             int
		optJob, expectTS bool
		want             Class
	}{
		{"clean minimum", true, true, 0, true, false, ClassOK},
		{"minimum with imag", true, true, 1, true, false, ClassImag},
		{"valid TS", true, true, 1, true, true, ClassOK},
		{"TS with zero imag", true, true, 0, true, true, ClassImag},
		{"TS not converged, stale imag", true, false, 1, true, true, ClassOptBroke},
		{"freq step died", false, true, 0, true, false, ClassFreqBroke},
		{"opt crashed", false, false, 0, true, false, ClassOptBroke},
		{"opt max cycles", true, false, 0, true, false, ClassOptBroke},
		{"pure freq clean", true, false, 0, false, false, ClassOK},
		{"pure freq died", false, false, 0, false, false, ClassFreqBroke},
	}
	for _, c := range cases {
		a := Analysis{Terminated: c.term, OptConverged: c.conv}
		for i := 0; i < c.imag; i++ {
			a.ImagModes = append(a.ImagModes, ImagMode{Index: i, FreqCM: -100})
		}
		if got := Classify(a, c.optJob, c.expectTS); got != c.want {
			t.Errorf("%s: Classify = %s, want %s", c.name, got, c.want)
		}
	}
}

func TestDisplaceScalesToMaxAtomicStep(t *testing.T) {
	geom := []Atom{{El: "O"}, {El: "H"}, {El: "H"}}
	// Atom 0 has the largest norm (0.1); scale must make ITS displacement 0.5.
	mode := []float64{0.1, 0, 0, -0.05, 0, 0, -0.05, 0, 0}
	out, err := Displace(geom, mode, 0.5)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(out[0].X-0.5) > 1e-12 {
		t.Errorf("atom 0 X = %f, want 0.5", out[0].X)
	}
	if math.Abs(out[1].X-(-0.25)) > 1e-12 {
		t.Errorf("atom 1 X = %f, want -0.25", out[1].X)
	}
}

func TestRestartKeywords(t *testing.T) {
	orig := []string{"B3LYP", "def2-SVP", "TightOpt", "Freq", "D3BJ"}
	if got := strings.Join(RestartKeywords(orig, ClassFreqBroke), " "); got != "B3LYP def2-SVP Freq D3BJ" {
		t.Errorf("FREQ_BROKE keywords = %q", got)
	}
	if got := strings.Join(RestartKeywords(orig, ClassImag), " "); got != "B3LYP def2-SVP TightOpt Freq D3BJ" {
		t.Errorf("IMAG keywords = %q", got)
	}
	// A bare-SP original gains Opt and Freq for an opt restart.
	if got := strings.Join(RestartKeywords([]string{"B3LYP", "def2-SVP"}, ClassOptBroke), " "); got != "B3LYP def2-SVP Opt Freq" {
		t.Errorf("OPT_BROKE keywords = %q", got)
	}
}

func TestBuildInput(t *testing.T) {
	inp := "! B3LYP def2-SVP TightOpt Freq\n%pal nprocs 8 end\n%maxcore 4000\n* xyz -1 2\nO 0.0 0.0 0.0\n*\n"
	summary := inputparse.Parse(inp)
	text := BuildInput(summary, RestartKeywords(summary.Keywords, ClassOptBroke), []Atom{{El: "O", X: 1, Y: 2, Z: 3}})
	for _, want := range []string{
		"! B3LYP def2-SVP TightOpt Freq\n",
		"%pal nprocs 8 end\n",
		"%maxcore 4000\n",
		"* xyz -1 2\n",
		"O       1.00000000     2.00000000     3.00000000\n",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("BuildInput missing %q in:\n%s", want, text)
		}
	}
	if !strings.HasSuffix(text, "*\n") {
		t.Errorf("BuildInput must close the coord block:\n%s", text)
	}
}

// A NEB output: endpoint pre-opts print the plain banner before the band;
// only a banner after "NEB OPTIMIZATION" is the TS phase.
const nebOutSkeleton = `
                    ***        THE OPTIMIZATION HAS CONVERGED     ***
 (reactant preopt)
                    ***        THE OPTIMIZATION HAS CONVERGED     ***
 (product preopt)
----------------------
NEB OPTIMIZATION      
----------------------
%s
`

func TestAnalyzeOutputNEBPhases(t *testing.T) {
	midBand := fmt.Sprintf(nebOutSkeleton, "")
	a := AnalyzeOutput(midBand)
	if !a.NEBBand || a.NEBConverged || a.OptConvergedPostNEB {
		t.Errorf("mid-band: NEBBand=%v NEBConverged=%v OptConvergedPostNEB=%v, want true/false/false",
			a.NEBBand, a.NEBConverged, a.OptConvergedPostNEB)
	}
	if !a.OptConverged {
		t.Error("mid-band: raw OptConverged should still see the preopt banners")
	}
	if a.ForNEBRun().OptConverged {
		t.Error("ForNEBRun must discard preopt-only convergence")
	}

	full := fmt.Sprintf(nebOutSkeleton, `
                    ***        THE NEB OPTIMIZATION HAS CONVERGED     ***
 (TS optimization follows)
                    ***        THE OPTIMIZATION HAS CONVERGED     ***
ORCA TERMINATED NORMALLY`)
	a = AnalyzeOutput(full)
	if !a.NEBConverged || !a.OptConvergedPostNEB {
		t.Errorf("full: NEBConverged=%v OptConvergedPostNEB=%v, want true/true", a.NEBConverged, a.OptConvergedPostNEB)
	}
	if !a.ForNEBRun().OptConverged {
		t.Error("ForNEBRun should keep post-band TS convergence")
	}
}

func TestNEBTSRestartKeywords(t *testing.T) {
	got := strings.Join(NEBTSRestartKeywords([]string{"XTB", "FAST-NEB-TS", "TightSCF"}), " ")
	if got != "XTB TightSCF OptTS Freq" {
		t.Errorf("NEBTSRestartKeywords = %q, want %q", got, "XTB TightSCF OptTS Freq")
	}
	// Existing OptTS/Freq tokens are not duplicated.
	got = strings.Join(NEBTSRestartKeywords([]string{"XTB", "NEB-TS", "Freq"}), " ")
	if got != "XTB Freq OptTS" {
		t.Errorf("NEBTSRestartKeywords = %q, want %q", got, "XTB Freq OptTS")
	}
}

func TestBuildInputExtraBlocks(t *testing.T) {
	summary := inputparse.Parse("! XTB NEB-TS\n* xyz 0 1\nH 0 0 0\n*\n")
	text := BuildInput(summary, NEBTSRestartKeywords(summary.Keywords), []Atom{{El: "H"}}, "%geom Calc_Hess true end")
	if !strings.Contains(text, "%geom Calc_Hess true end\n") {
		t.Errorf("BuildInput missing extra block:\n%s", text)
	}
	if strings.Contains(text, "NEB-TS") {
		t.Errorf("restart input must not keep the NEB driver:\n%s", text)
	}
}
