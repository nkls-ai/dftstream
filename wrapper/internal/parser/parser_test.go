package parser

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"
)

func collect(t *testing.T, text string) []Event {
	t.Helper()
	ch := make(chan Event, 1024)
	done := make(chan error, 1)
	go func() {
		done <- New(func() time.Time { return time.Unix(0, 0) }).Parse(context.Background(), strings.NewReader(text), ch)
		close(ch)
	}()
	var events []Event
	for e := range ch {
		events = append(events, e)
	}
	if err := <-done; err != nil {
		t.Fatalf("parse: %v", err)
	}
	return events
}

func TestWaterSP(t *testing.T) {
	events := collect(t, waterSPLog)

	geometries := 0
	scfIters := 0
	runEnds := 0
	finalSP := 0.0
	terminated := false
	for _, e := range events {
		switch ev := e.(type) {
		case GeometryEvent:
			geometries++
		case ScfIterEvent:
			scfIters++
		case FinalSPEvent:
			finalSP = ev.Energy
		case RunEndEvent:
			runEnds++
			if ev.Normal {
				terminated = true
			}
		}
	}

	if geometries < 1 {
		t.Errorf("expected >=1 geometry, got %d", geometries)
	}
	if scfIters < 1 {
		t.Errorf("expected SCF iteration events, got %d", scfIters)
	}
	if math.Abs(finalSP-(-75.983948120000)) > 1e-9 {
		t.Errorf("final SP mismatch: got %.12f", finalSP)
	}
	if !terminated {
		t.Errorf("missed ORCA TERMINATED NORMALLY")
	}
	if runEnds != 1 {
		t.Errorf("expected exactly one run end event, got %d", runEnds)
	}
}

func TestWaterOptFreq(t *testing.T) {
	events := collect(t, waterOptFreqLog)

	var (
		cycleSet     = map[int]bool{}
		lastFinalSP  float64
		geometries   int
		scfIters     int
		freqsLast    []Frequency
		scfConverged int
		runEnds      int
		runEnd       *RunEndEvent
	)
	for _, e := range events {
		switch ev := e.(type) {
		case GeometryEvent:
			geometries++
			cycleSet[ev.Cycle] = true
		case ScfIterEvent:
			scfIters++
		case FinalSPEvent:
			lastFinalSP = ev.Energy
		case FrequenciesEvent:
			freqsLast = ev.Items
		case ScfConvergedEvent:
			scfConverged++
		case RunEndEvent:
			runEnds++
			runEnd = &ev
		}
	}

	if geometries != 2 {
		t.Errorf("expected two geometries, got %d", geometries)
	}
	if scfIters != 4 {
		t.Errorf("expected four SCF iteration rows, got %d", scfIters)
	}
	if math.Abs(lastFinalSP-(-75.986100000000)) > 1e-9 {
		t.Errorf("last final SP mismatch: got %.12f", lastFinalSP)
	}
	if scfConverged != 2 {
		t.Errorf("expected two SCF convergences, got %d", scfConverged)
	}
	if runEnd == nil || !runEnd.Normal {
		t.Errorf("missed terminated-normally / run end")
	}
	if runEnds != 1 {
		t.Errorf("expected exactly one run end event, got %d", runEnds)
	}
	if runEnd != nil && runEnd.Wallclock == 0 {
		t.Errorf("expected wallclock from TOTAL RUN TIME")
	}
	if len(freqsLast) == 0 {
		t.Errorf("expected final vibrational frequencies")
	}
	if len(freqsLast) != 3 {
		t.Errorf("expected three vibrational frequencies, got %d", len(freqsLast))
	}
	if len(freqsLast) > 0 && !freqsLast[0].Imaginary {
		t.Errorf("expected first synthetic water mode to be imaginary, got %v", freqsLast[0])
	}
}

// Recalc_Hess-style runs print several VIBRATIONAL FREQUENCIES blocks;
// each must carry its own 1-based hessian ordinal.
func TestFrequenciesHessianIndex(t *testing.T) {
	const log = `Program Version 6.1.0
VIBRATIONAL FREQUENCIES
  0:    -512.34 cm**-1  ***imaginary mode***
  1:    1600.00 cm**-1
END FREQ
some unrelated line
VIBRATIONAL FREQUENCIES
  0:    -100.00 cm**-1  ***imaginary mode***
  1:    1650.00 cm**-1
END FREQ
IR SPECTRUM
   1:   1650.00   0.000060   12.30   0.011  ( 0.1  0.0  0.0)
END IR
ORCA TERMINATED NORMALLY
`
	events := collect(t, log)
	var freqEvents []FrequenciesEvent
	for _, e := range events {
		if ev, ok := e.(FrequenciesEvent); ok {
			freqEvents = append(freqEvents, ev)
		}
	}
	if len(freqEvents) != 2 {
		t.Fatalf("got %d frequency events, want 2", len(freqEvents))
	}
	if freqEvents[0].HessIdx != 1 || freqEvents[1].HessIdx != 2 {
		t.Errorf("hess indices = %d, %d, want 1, 2", freqEvents[0].HessIdx, freqEvents[1].HessIdx)
	}
	if math.Abs(freqEvents[0].Items[0].Wavenumber-(-512.34)) > 1e-9 {
		t.Errorf("first block wavenumber = %v", freqEvents[0].Items[0].Wavenumber)
	}
	if len(freqEvents[1].Items) != 2 || math.Abs(freqEvents[1].Items[1].IRIntensity-12.30) > 1e-9 {
		t.Errorf("second block should carry IR intensity, got %+v", freqEvents[1].Items)
	}
}

// A frequency block cut off by EOF still flushes with the current ordinal.
func TestFrequenciesHessianIndexEOFFlush(t *testing.T) {
	const log = `Program Version 6.1.0
VIBRATIONAL FREQUENCIES
  0:    1595.12 cm**-1
END FREQ
VIBRATIONAL FREQUENCIES
  0:    -12.34 cm**-1  ***imaginary mode***
`
	events := collect(t, log)
	var freqEvents []FrequenciesEvent
	for _, e := range events {
		if ev, ok := e.(FrequenciesEvent); ok {
			freqEvents = append(freqEvents, ev)
		}
	}
	if len(freqEvents) != 2 {
		t.Fatalf("got %d frequency events, want 2", len(freqEvents))
	}
	if freqEvents[0].HessIdx != 1 || freqEvents[1].HessIdx != 2 {
		t.Errorf("hess indices = %d, %d, want 1, 2", freqEvents[0].HessIdx, freqEvents[1].HessIdx)
	}
	if !freqEvents[1].Items[0].Imaginary {
		t.Errorf("EOF-flushed block lost the imaginary flag: %+v", freqEvents[1].Items)
	}
}

func TestThermochemistry(t *testing.T) {
	const log = `Program Version 6.1.0
--------------------------
THERMOCHEMISTRY AT 298.15K
--------------------------

Zero point energy                ...      0.008608 Eh       5.40 kcal/mol
Total thermal energy                    -75.960014 Eh

Total enthalpy                   ...    -75.959070 Eh

Total entropy correction         ...     -0.021416 Eh      -13.44 kcal/mol

Final Gibbs free energy          ...    -75.980486 Eh

For completeness - the Gibbs free energy minus the electronic energy
G-E(el)                          ...      0.005614 Eh        3.52 kcal/mol

                             ****ORCA TERMINATED NORMALLY****
`
	events := collect(t, log)

	var thermo *ThermoEvent
	count := 0
	for _, e := range events {
		if ev, ok := e.(ThermoEvent); ok {
			count++
			thermo = &ev
		}
	}
	if count != 1 {
		t.Fatalf("expected exactly one ThermoEvent, got %d", count)
	}
	check := func(name string, got *float64, want float64) {
		t.Helper()
		if got == nil {
			t.Errorf("%s missing", name)
			return
		}
		if math.Abs(*got-want) > 1e-9 {
			t.Errorf("%s = %.9f, want %.9f", name, *got, want)
		}
	}
	check("ZPE", thermo.ZPEEh, 0.008608)
	check("enthalpy", thermo.EnthalpyEh, -75.959070)
	check("entropy correction", thermo.EntropyCorrEh, -0.021416)
	check("Gibbs", thermo.GibbsEh, -75.980486)
	check("G-E(el)", thermo.GMinusEEh, 0.005614)
}

func TestThermochemistryTruncated(t *testing.T) {
	// A run killed mid-thermochemistry (no G-E(el) row) must still flush
	// the partial section at EOF.
	const log = `Program Version 6.1.0
Zero point energy                ...      0.008608 Eh       5.40 kcal/mol
Final Gibbs free energy          ...    -75.980486 Eh
`
	events := collect(t, log)
	var thermo *ThermoEvent
	for _, e := range events {
		if ev, ok := e.(ThermoEvent); ok {
			thermo = &ev
		}
	}
	if thermo == nil {
		t.Fatal("expected a ThermoEvent from the EOF flush")
	}
	if thermo.GibbsEh == nil || math.Abs(*thermo.GibbsEh-(-75.980486)) > 1e-9 {
		t.Errorf("Gibbs = %v, want -75.980486", thermo.GibbsEh)
	}
	if thermo.GMinusEEh != nil {
		t.Errorf("G-E(el) should be nil for truncated section, got %v", *thermo.GMinusEEh)
	}
}

func TestNMRShielding(t *testing.T) {
	events := collect(t, nmrLog)

	var nmr *NMRShieldsEvent
	for _, e := range events {
		if ev, ok := e.(NMRShieldsEvent); ok {
			nmr = &ev
		}
	}
	if nmr == nil {
		t.Fatal("expected NMRShieldsEvent")
	}
	if len(nmr.Items) != 5 {
		t.Fatalf("expected 5 NMR shields, got %d", len(nmr.Items))
	}

	// Check first atom (C)
	if nmr.Items[0].Element != "C" {
		t.Errorf("atom 0 element = %q, want C", nmr.Items[0].Element)
	}
	if nmr.Items[0].AtomIdx != 0 {
		t.Errorf("atom 0 idx = %d, want 0", nmr.Items[0].AtomIdx)
	}
	if math.Abs(nmr.Items[0].Isotropic-57.1234) > 0.001 {
		t.Errorf("atom 0 isotropic = %f, want 57.1234", nmr.Items[0].Isotropic)
	}

	// Check hydrogen
	h := nmr.Items[2]
	if h.Element != "H" {
		t.Errorf("atom 2 element = %q, want H", h.Element)
	}
	if math.Abs(h.Isotropic-30.8765) > 0.001 {
		t.Errorf("atom 2 isotropic = %f, want 30.8765", h.Isotropic)
	}
}

func TestTDDFTWithNMR(t *testing.T) {
	// Verify both events can coexist in the same output
	combined := tddftLog + "\n" + nmrShieldingBlock
	events := collect(t, combined)

	var gotExcited, gotNMR bool
	for _, e := range events {
		switch e.(type) {
		case ExcitedStatesEvent:
			gotExcited = true
		case NMRShieldsEvent:
			gotNMR = true
		}
	}
	if !gotExcited {
		t.Error("missing ExcitedStatesEvent")
	}
	if !gotNMR {
		t.Error("missing NMRShieldsEvent")
	}
}

func TestMECPPoints(t *testing.T) {
	events := collect(t, mecpLog)

	var points []MECPPointEvent
	var converged bool
	for _, e := range events {
		switch ev := e.(type) {
		case MECPPointEvent:
			points = append(points, ev)
		case OptConvergedEvent:
			converged = true
		}
	}
	if len(points) != 2 {
		t.Fatalf("expected 2 MECP points, got %d", len(points))
	}
	if points[0].Cycle != 1 || math.Abs(points[0].State1Energy-(-155.100000)) > 1e-9 {
		t.Fatalf("first point mismatch: %+v", points[0])
	}
	if math.Abs(points[1].Gap-0.00001) > 1e-9 {
		t.Fatalf("gap = %.8f, want 0.00001", points[1].Gap)
	}
	if !converged {
		t.Fatal("expected MECP convergence to emit OptConvergedEvent")
	}
}

const mecpLog = `Program Version 6.1.0
MINIMUM ENERGY CROSSING POINT OPTIMIZATION

GEOMETRY OPTIMIZATION CYCLE   1
State 1 energy: -155.100000 Eh
State 2 energy: -155.095000 Eh
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
Fe     0.000000   0.000000   0.000000
N      1.900000   0.000000   0.000000

GEOMETRY OPTIMIZATION CYCLE   2
E(1) = -155.120000 Eh   E(2) = -155.119990 Eh
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
Fe     0.010000   0.000000   0.000000
N      1.880000   0.000000   0.000000

THE MECP OPTIMIZATION HAS CONVERGED
TOTAL RUN TIME: 0 days 0 hours 7 minutes 0 seconds 0 msec
ORCA TERMINATED NORMALLY
`

// TestMECPGapLineNotMistakenForState guards the single-state regexes
// against a real-ORCA gap line such as "Energy gap (E2 - E1):  0.012".
// The "E1):" fragment otherwise reads as "state 1 = number" and the gap
// value clobbers the true surface-1 energy. Asserted at the parse level
// because the emit-on-both-seen path can mask the corruption depending
// on line order — the regex must reject the gap line regardless.
func TestMECPGapLineNotMistakenForState(t *testing.T) {
	if v, ok := parseMECPState1("State 1 energy:    -1338.41027600 Eh"); !ok || math.Abs(v-(-1338.410276)) > 1e-9 {
		t.Fatalf("state-1 line: got (%.6f, %v), want (-1338.410276, true)", v, ok)
	}
	if v, ok := parseMECPState2("State 2 energy:    -1338.39810400 Eh"); !ok || math.Abs(v-(-1338.398104)) > 1e-9 {
		t.Fatalf("state-2 line: got (%.6f, %v), want (-1338.398104, true)", v, ok)
	}
	gap := "Energy gap (E2 - E1):     0.01217200 Eh     7.638 kcal/mol"
	if v, ok := parseMECPState1(gap); ok {
		t.Fatalf("gap line matched state-1 regex: got %.6f, want no match", v)
	}
	if v, ok := parseMECPState2(gap); ok {
		t.Fatalf("gap line matched state-2 regex: got %.6f, want no match", v)
	}
}

const nmrShieldingBlock = `
CHEMICAL SHIELDING SUMMARY (ppm)
-------------------------------
  Nucleus  Element    Isotropic     Anisotropy
      0       C        57.1234       42.5678
      1       C       125.4567       38.9012
      2       H        30.8765       12.3456
      3       H        31.2345       11.8901
      4       O       287.6543       98.7654
DONE
`

const nmrLog = `Program Version 6.1.0
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
C      0.000000   0.000000   0.000000
C      1.540000   0.000000   0.000000
H      2.130000   0.890000   0.000000
H     -0.590000  -0.890000   0.000000
O      0.000000   0.000000   1.210000

----------------------------------------D-I-I-S--------------------------------------------
Iteration    Energy (Eh)           Delta-E    RMSDP     MaxDP     DIISErr   Damp  Time(sec)
-------------------------------------------------------------------------------------------
    1     -150.1234567890000000     0.00e+00  1.00e-03  2.00e-03  3.00e-03  0.700   0.1
    2     -150.4567890120000000    -3.33e-01  2.00e-04  3.00e-04  4.00e-04  0.700   0.1
               *****************************************************
               *                     SUCCESS                       *
SCF CONVERGED AFTER   2 CYCLES
Total Energy       :        -150.45678901 Eh
FINAL SINGLE POINT ENERGY     -150.456789012000
CHEMICAL SHIELDING SUMMARY (ppm)
-------------------------------
  Nucleus  Element    Isotropic     Anisotropy
      0       C        57.1234       42.5678
      1       C       125.4567       38.9012
      2       H        30.8765       12.3456
      3       H        31.2345       11.8901
      4       O       287.6543       98.7654
DONE
TOTAL RUN TIME: 0 days 0 hours 2 minutes 15 seconds 300 msec
ORCA TERMINATED NORMALLY
`

const waterSPLog = `Program Version 6.1.0
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
O      0.000000   0.000000   0.062600
H     -0.792000   0.000000  -0.497300
H      0.792000   0.000000  -0.497300

----------------------------------------D-I-I-S--------------------------------------------
Iteration    Energy (Eh)           Delta-E    RMSDP     MaxDP     DIISErr   Damp  Time(sec)
-------------------------------------------------------------------------------------------
    1     -75.9000000000000000     0.00e+00  1.00e-03  2.00e-03  3.00e-03  0.700   0.1
Warning: Small HOMO/LUMO gap - skipping pre-diagonalization
    2     -75.9839481200000000    -8.39e-02  2.00e-04  3.00e-04  4.00e-04  0.700   0.1
               *****************************************************
               *                     SUCCESS                       *
SCF CONVERGED AFTER   2 CYCLES
Total Energy       :         -75.98394812 Eh
FINAL SINGLE POINT ENERGY      -75.983948120000
TOTAL RUN TIME: 0 days 0 hours 0 minutes 1 seconds 5 msec
ORCA TERMINATED NORMALLY
`

func TestTDDFTAbsorptionSpectrum(t *testing.T) {
	events := collect(t, tddftLog)

	var excited *ExcitedStatesEvent
	for _, e := range events {
		if ev, ok := e.(ExcitedStatesEvent); ok {
			excited = &ev
		}
	}
	if excited == nil {
		t.Fatal("expected ExcitedStatesEvent")
	}
	if len(excited.Items) != 3 {
		t.Fatalf("expected 3 excited states, got %d", len(excited.Items))
	}
	s0 := excited.Items[0]
	if s0.Index != 0 {
		t.Errorf("state 0 index = %d", s0.Index)
	}
	if math.Abs(s0.WavelengthNM-260.1) > 0.2 {
		t.Errorf("state 0 wavelength = %.1f, want ~260.1", s0.WavelengthNM)
	}
	if math.Abs(s0.OscStrength-0.0001) > 0.001 {
		t.Errorf("state 0 fosc = %f, want ~0.0001", s0.OscStrength)
	}
	s2 := excited.Items[2]
	if s2.Index != 2 {
		t.Errorf("state 2 index = %d", s2.Index)
	}
	if math.Abs(s2.OscStrength-0.0523) > 0.001 {
		t.Errorf("state 2 fosc = %f, want ~0.0523", s2.OscStrength)
	}
	if len(s2.Transitions) == 0 {
		t.Error("state 2 should have orbital transitions")
	}
	if len(s2.Transitions) > 0 && s2.Transitions[0].From != "137a" {
		t.Errorf("transition from = %q, want 137a", s2.Transitions[0].From)
	}
}

const tddftLog = `Program Version 6.1.0
FINAL SINGLE POINT ENERGY      -500.123456000000

ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS
-----------------------------------------------------------------------------
 State   Energy    Wavelength   fosc        T2        TX        TY        TZ
         (cm-1)      (nm)                 (au**2)    (au)      (au)      (au)
-----------------------------------------------------------------------------
    0  38440.7      260.1   0.000100000   0.00000000   0.00000000   0.00000000   0.00000000
    1  41200.3      242.7   0.012300000   0.00100000   0.01000000   0.00500000   0.00200000
    2  43500.1      229.9   0.052300000   0.00500000   0.05000000   0.02000000   0.01000000

TD-DFT/TDA EXCITED STATES (ACTIVE)
-----------------------------------
STATE  0:  E=   0.119073 au   3.240 eV   26134.5 cm**-1
   135a ->  138a  :     0.123456 (c= 0.35000)
   136a ->  138a  :     0.654321 (c= 0.80000)
STATE  1:  E=   0.126000 au   3.429 eV   27665.0 cm**-1
   137a ->  138a  :     0.987654 (c= 0.99000)
STATE  2:  E=   0.134000 au   3.647 eV   29421.0 cm**-1
   137a ->  139a  :     0.876543 (c= 0.93000)
   136a ->  139a  :     0.100000 (c= 0.31600)

TOTAL RUN TIME: 0 days 0 hours 5 minutes 30 seconds 100 msec
ORCA TERMINATED NORMALLY
`

const waterOptFreqLog = `Program Version 6.1.0
Program running with 4 parallel MPI-processes
GEOMETRY OPTIMIZATION CYCLE   1
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
O      0.000000   0.000000   0.062600
H     -0.792000   0.000000  -0.497300
H      0.792000   0.000000  -0.497300

----------------------------------------D-I-I-S--------------------------------------------
Iteration    Energy (Eh)           Delta-E    RMSDP     MaxDP     DIISErr   Damp  Time(sec)
-------------------------------------------------------------------------------------------
    1     -75.9800000000000000     0.00e+00  1.00e-03  2.00e-03  3.00e-03  0.700   0.1
    2     -75.9840000000000000    -4.00e-03  2.00e-04  3.00e-04  4.00e-04  0.700   0.1
               *****************************************************
               *                     SUCCESS                       *
SCF CONVERGED AFTER   2 CYCLES
Total Energy       :         -75.98400000 Eh
FINAL SINGLE POINT ENERGY      -75.984000000000
GEOMETRY OPTIMIZATION CYCLE   2
CARTESIAN COORDINATES (ANGSTROEM)
---------------------------------
O      0.000000   0.000000   0.060000
H     -0.790000   0.000000  -0.498000
H      0.790000   0.000000  -0.498000

----------------------------------------D-I-I-S--------------------------------------------
Iteration    Energy (Eh)           Delta-E    RMSDP     MaxDP     DIISErr   Damp  Time(sec)
-------------------------------------------------------------------------------------------
    1     -75.9850000000000000     0.00e+00  1.00e-03  2.00e-03  3.00e-03  0.700   0.1
    2     -75.9861000000000000    -1.10e-03  2.00e-04  3.00e-04  4.00e-04  0.700   0.1
               *****************************************************
               *                     SUCCESS                       *
SCF CONVERGED AFTER   2 CYCLES
Total Energy       :         -75.98610000 Eh
FINAL SINGLE POINT ENERGY      -75.986100000000
VIBRATIONAL FREQUENCIES
  0:     -12.34 cm**-1  ***imaginary mode***
  1:    1595.12 cm**-1
  2:    3657.89 cm**-1
END FREQ
TOTAL RUN TIME: 0 days 0 hours 0 minutes 2 seconds 10 msec
ORCA TERMINATED NORMALLY
`

func TestSpinContamination(t *testing.T) {
	const log = `Program Version 6.1.0
Expectation value of <S**2>     :     0.805619
Ideal value S*(S+1) for S=0.5   :     0.750000
Deviation                       :     0.055619

Expectation value of <S**2>     :     0.796072
Ideal value S*(S+1) for S=0.5   :     0.750000
`
	events := collect(t, log)
	var spins []SpinContaminationEvent
	for _, e := range events {
		if ev, ok := e.(SpinContaminationEvent); ok {
			spins = append(spins, ev)
		}
	}
	if len(spins) != 2 {
		t.Fatalf("got %d spin events, want 2", len(spins))
	}
	if math.Abs(spins[0].S2-0.805619) > 1e-9 || math.Abs(spins[0].S2Ideal-0.75) > 1e-9 {
		t.Errorf("first event = %+v, want S2 0.805619 ideal 0.75", spins[0])
	}
	if math.Abs(spins[1].S2-0.796072) > 1e-9 {
		t.Errorf("second event S2 = %v, want 0.796072", spins[1].S2)
	}
}

// An "Ideal value" line without a preceding expectation row must not emit.
func TestSpinContaminationIdealAloneIgnored(t *testing.T) {
	events := collect(t, "Ideal value S*(S+1) for S=0.5   :     0.750000\n")
	for _, e := range events {
		if _, ok := e.(SpinContaminationEvent); ok {
			t.Fatal("unexpected spin event from ideal-only line")
		}
	}
}

// NEB runs mark the band phase with a "NEB OPTIMIZATION" section header
// and end it with their own convergence banner; both must emit events,
// and the banner must NOT be mistaken for the plain opt-converged one.
func TestNEBPhaseLandmarks(t *testing.T) {
	events := collect(t, `
----------------------
NEB OPTIMIZATION      
----------------------

Optimization log-file                    ....  x.NEB.log

                    *********************H U R R A Y*********************
                    ***        THE NEB OPTIMIZATION HAS CONVERGED     ***
                    *****************************************************
`)
	var starts, nebConv, optConv int
	for _, ev := range events {
		switch ev.(type) {
		case NEBPhaseStartEvent:
			starts++
		case NEBConvergedEvent:
			nebConv++
		case OptConvergedEvent:
			optConv++
		}
	}
	if starts != 1 {
		t.Errorf("NEBPhaseStartEvent count = %d, want 1", starts)
	}
	if nebConv != 1 {
		t.Errorf("NEBConvergedEvent count = %d, want 1", nebConv)
	}
	if optConv != 0 {
		t.Errorf("OptConvergedEvent count = %d, want 0 (NEB banner is not the plain opt banner)", optConv)
	}
}
