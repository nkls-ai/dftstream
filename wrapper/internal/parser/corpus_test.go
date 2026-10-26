package parser

import (
	"compress/gzip"
	"context"
	"errors"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nkls-ai/dftstream/internal/inputparse"
)

// This file is the parser's golden regression corpus. Two tables:
//
//   - corpusCases: real ORCA outputs tracked under testdata/corpus/,
//     organized by release series (5.x / 6.0 / 6.1 / unversioned) and
//     gzip-compressed (the loader reads <name>.out or <name>.out.gz
//     transparently; input files stay plain). Every value in the table
//     was read out of the fixture by hand and checked against the output
//     itself; they are the contract for what the parser must keep
//     extracting.
//   - diagCases: the small synthetic outputs directly under testdata/,
//     each built from ORCA's verbatim message text for one failure class.
//     Real outputs of most failure modes are not something we can produce
//     on demand, so the failure catalogue is pinned here instead.
//
// Fixtures are tagged with the ORCA release series they came from so a
// per-series wording divergence shows up as a per-series failure rather
// than a mystery. A case whose fixture file is missing skips locally, but
// FAILS when DFTSTREAM_REQUIRE_CORPUS is set — CI sets it, so the corpus
// actually gates merges instead of silently skipping.
//
// Series-matrix coverage (see the guard at the end of
// TestCorpusRealOutputs):
//
//	5.x  — NO real full-run fixture yet. The 5.x column is covered only
//	       by the synthetic failure fixture orca5_scf_not_converged.out
//	       and the 5.x absorption-layout unit test below. A donated real
//	       ORCA 5 output belongs in testdata/corpus/5.x/.
//	6.0  — one real fixture (TS_A1_CO2_bending, ORCA 6.0.1).
//	6.1  — the bulk of the corpus (6.1.0 and 6.1.1).

// ---------------------------------------------------------------------
// Fixture summary
// ---------------------------------------------------------------------

// parsedRun is everything the corpus asserts about one output, folded out
// of the event stream the same way the runner folds it.
type parsedRun struct {
	orcaVersion  string
	nprocs       int
	terminated   bool
	wallclock    time.Duration
	optConverged bool
	optMaxCycles bool
	nebConverged bool
	geometries   int
	scfIters     int
	mecpPoints   int
	finalSP      *float64
	// last VIBRATIONAL FREQUENCIES block only — the one that describes
	// the final geometry.
	freqCount     int
	imaginary     *int
	hessBlocks    int
	zpe           *float64
	enthalpy      *float64
	gibbs         *float64
	excitedStates int
	nmrShields    int
	diagnostics   []DiagnosticEvent
}

func (p parsedRun) classes() []ErrorClass {
	out := make([]ErrorClass, 0, len(p.diagnostics))
	for _, d := range p.diagnostics {
		out = append(out, d.Class)
	}
	return out
}

// requireCorpus reports whether a missing corpus fixture is a failure
// rather than a skip. CI sets DFTSTREAM_REQUIRE_CORPUS=1 so the corpus
// gates merges; a local checkout without the fixtures still skips.
func requireCorpus() bool {
	return os.Getenv("DFTSTREAM_REQUIRE_CORPUS") != ""
}

// findFixture resolves a fixture path, preferring the plain file and
// falling back to a gzip sibling (large corpus outputs are tracked as
// .out.gz). ok is false when neither exists.
func findFixture(t *testing.T, path string) (string, bool) {
	t.Helper()
	for _, p := range []string{path, path + ".gz"} {
		if _, err := os.Stat(p); err == nil {
			return p, true
		} else if !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("stat %s: %v", p, err)
		}
	}
	return "", false
}

// parseFile runs the parser over a whole file and folds the events. A
// path ending in .gz is decompressed on the fly.
func parseFile(t *testing.T, path string) parsedRun {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Errorf("close %s: %v", path, err)
		}
	}()
	var r io.Reader = f
	if strings.HasSuffix(path, ".gz") {
		zr, err := gzip.NewReader(f)
		if err != nil {
			t.Fatalf("gzip %s: %v", path, err)
		}
		defer func() {
			// Close also verifies the gzip checksum — an error here
			// means the fixture is corrupt, not that cleanup failed.
			if err := zr.Close(); err != nil {
				t.Errorf("gzip close %s: %v", path, err)
			}
		}()
		r = zr
	}

	ch := make(chan Event, 512)
	done := make(chan error, 1)
	go func() {
		done <- New(func() time.Time { return time.Unix(0, 0) }).Parse(context.Background(), r, ch)
		close(ch)
	}()

	var run parsedRun
	for e := range ch {
		switch ev := e.(type) {
		case RunStartEvent:
			if ev.OrcaVersion != "" {
				run.orcaVersion = ev.OrcaVersion
			}
			if ev.NProcs > 0 {
				run.nprocs = ev.NProcs
			}
		case GeometryEvent:
			run.geometries++
		case ScfIterEvent:
			run.scfIters++
		case MECPPointEvent:
			run.mecpPoints++
		case FinalSPEvent:
			v := ev.Energy
			run.finalSP = &v
		case OptConvergedEvent:
			run.optConverged = true
		case OptNotConvergedEvent:
			run.optMaxCycles = true
		case NEBConvergedEvent:
			run.nebConverged = true
		case FrequenciesEvent:
			n := 0
			for _, fr := range ev.Items {
				if fr.Imaginary {
					n++
				}
			}
			run.freqCount = len(ev.Items)
			run.imaginary = &n
			run.hessBlocks = ev.HessIdx
		case ThermoEvent:
			run.zpe, run.enthalpy, run.gibbs = ev.ZPEEh, ev.EnthalpyEh, ev.GibbsEh
		case ExcitedStatesEvent:
			run.excitedStates = len(ev.Items)
		case NMRShieldsEvent:
			run.nmrShields = len(ev.Items)
		case DiagnosticEvent:
			run.diagnostics = append(run.diagnostics, ev)
		case RunEndEvent:
			run.terminated = ev.Normal
			run.wallclock = ev.Wallclock
		}
	}
	if err := <-done; err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return run
}

// ---------------------------------------------------------------------
// Real-output corpus
// ---------------------------------------------------------------------

// series is the ORCA release line a fixture came from. The roadmap's
// corpus matrix splits the 6.x line into 6.0 and 6.1 — the two diverge
// in output wording (absorption tables, SCF failure text), so they are
// separate cells.
type series string

const (
	series5  series = "5.x"
	series60 series = "6.0"
	series61 series = "6.1"
	// seriesUnknown is for hand-built fixtures with no version banner.
	seriesUnknown series = ""
)

// seriesOf buckets a "6.1.0"-style version string. A future 6.2 (or 7.x)
// deliberately maps to seriesUnknown so the first fixture from a new
// release line fails loudly instead of hiding in an existing bucket.
func seriesOf(version string) series {
	switch {
	case strings.HasPrefix(version, "5."):
		return series5
	case strings.HasPrefix(version, "6.0"):
		return series60
	case strings.HasPrefix(version, "6.1"):
		return series61
	default:
		return seriesUnknown
	}
}

type corpusCase struct {
	name string
	// out and inp are relative to testdata/. out names the logical file
	// ("corpus/6.1/x.out"); the loader falls back to "x.out.gz", which is
	// how the large fixtures are tracked. inp is optional: it drives the
	// run-type assertion, and a few fixtures have no input file kept.
	out, inp string
	series   series
	version  string
	runTypes []inputparse.RunType

	terminated   bool
	optConverged bool
	nebConverged bool
	nprocs       int

	geometriesAtLeast int
	scfItersAtLeast   int
	finalSP           *float64

	// freqCount/imaginary/hessBlocks describe the LAST frequency block.
	// imaginary nil means the output has no frequency section at all.
	freqCount  int
	imaginary  *int
	hessBlocks int

	zpe, enthalpy, gibbs *float64

	classes []ErrorClass
}

func fp(v float64) *float64 { return &v }
func ip(v int) *int         { return &v }

// corpusCases pins the parse of every ORCA output kept in the repo.
//
// Energies are asserted to 1e-8 Eh — they come straight out of the file,
// so any drift is a regression in the number extraction, not in ORCA.
var corpusCases = []corpusCase{
	// --- small single-point / opt-freq fixtures -----------------------
	{
		name: "water_hf_svp_sp", series: series61, version: "6.1.1",
		out: "corpus/6.1/water_hf_def2svp_sp.out",
		inp: "corpus/6.1/water_hf_def2svp_sp.inp",
		// No run-type keyword: ORCA's own default is a single point.
		runTypes:          []inputparse.RunType{inputparse.RunTypeSP},
		terminated:        true,
		geometriesAtLeast: 1, scfItersAtLeast: 9,
		finalSP: fp(-75.95934030),
	},
	{
		name: "water_hf_tzvp_sp", series: series61, version: "6.1.1",
		out:               "corpus/6.1/water_hf_def2tzvp_sp.out",
		inp:               "corpus/6.1/water_hf_def2tzvp_sp.inp",
		runTypes:          []inputparse.RunType{inputparse.RunTypeSP},
		terminated:        true,
		geometriesAtLeast: 1, scfItersAtLeast: 10,
		finalSP: fp(-76.05758827),
	},
	{
		name: "water_hf_svp_opt_freq", series: series61, version: "6.1.1",
		out:               "corpus/6.1/water_hf_def2svp_opt_freq.out",
		inp:               "corpus/6.1/water_hf_def2svp_opt_freq.inp",
		runTypes:          []inputparse.RunType{inputparse.RunTypeOpt, inputparse.RunTypeFreq},
		terminated:        true,
		optConverged:      true,
		geometriesAtLeast: 6, scfItersAtLeast: 30,
		finalSP:   fp(-75.96133849),
		freqCount: 9, imaginary: ip(0), hessBlocks: 1,
		zpe: fp(0.02310914), enthalpy: fp(-75.93445089), gibbs: fp(-75.95582115),
	},

	// --- large production outputs (tracked gzipped) -------------------
	{
		name: "sp_b1_oss_wb97xv_qzvpp", series: series61, version: "6.1.0",
		out:               "corpus/6.1/sp_b1-oss_wb97x-v-qzvpp.out",
		inp:               "corpus/6.1/sp_b1-oss_wb97x-v-qzvpp.inp",
		runTypes:          []inputparse.RunType{inputparse.RunTypeSP},
		terminated:        true,
		nprocs:            8,
		geometriesAtLeast: 1, scfItersAtLeast: 30,
		finalSP: fp(-974.99447968),
	},
	{
		// OptTS whose final Hessian has NO imaginary mode: the converged
		// structure is a minimum, not the saddle point that was asked
		// for. The first Hessian (the TS guess) has two. Only the last
		// block is the run's answer — this fixture is the regression
		// guard for that rule.
		name: "opt_ts_b1_oss_c1", series: series61, version: "6.1.0",
		out:               "corpus/6.1/opt-ts_b1-oss-c1_r2scan-3c_002.out",
		terminated:        true,
		optConverged:      true,
		nprocs:            8,
		geometriesAtLeast: 50, scfItersAtLeast: 500,
		finalSP:   fp(-974.77623391),
		freqCount: 78, imaginary: ip(0), hessBlocks: 2,
		zpe: fp(0.20301635), enthalpy: fp(-974.55936135), gibbs: fp(-974.61161544),
	},
	{
		// ORCA 6.0 fixture, and the only one with a double-digit number
		// of Hessian blocks (Recalc_Hess). A true TS: exactly one
		// imaginary mode in the last block.
		name: "ts_a1_co2_bending", series: series60, version: "6.0.1",
		out: "corpus/6.0/TS_A1_CO2_bending_H_plus_Trial_3.out",
		inp: "corpus/6.0/TS_A1_CO2_bending_H_plus_Trial_3.inp",
		runTypes: []inputparse.RunType{
			inputparse.RunTypeOptTS, inputparse.RunTypeFreq,
		},
		terminated:        true,
		optConverged:      true,
		nprocs:            32,
		geometriesAtLeast: 100, scfItersAtLeast: 1500,
		finalSP:   fp(-5530.68655109),
		freqCount: 246, imaginary: ip(1), hessBlocks: 13,
		zpe: fp(0.60183716), enthalpy: fp(-5530.03748448), gibbs: fp(-5530.15686193),
	},

	// --- the job corpus: one fixture per run type ---------------------
	{
		name: "goat_ma1_xtb", series: series61, version: "6.1.0",
		out:               "corpus/6.1/goat_ma1_xtb.out",
		inp:               "corpus/6.1/goat_ma1_xtb.inp",
		runTypes:          []inputparse.RunType{inputparse.RunTypeGoat},
		terminated:        true,
		optConverged:      true, // every conformer optimization prints the banner
		geometriesAtLeast: 13,
		finalSP:           fp(-27.36622566),
	},
	{
		// IRC outputs carry their energies in the IRC summary table, not
		// in a FINAL SINGLE POINT ENERGY line — finalSP is nil on
		// purpose. See the note in the package test report.
		name: "irc_malonaldehyde_xtb", series: series61, version: "6.1.0",
		out:               "corpus/6.1/irc_malonaldehyde_xtb.out",
		inp:               "corpus/6.1/irc_malonaldehyde_xtb.inp",
		runTypes:          []inputparse.RunType{inputparse.RunTypeIRC},
		terminated:        true,
		nprocs:            4,
		geometriesAtLeast: 22, scfItersAtLeast: 5,
	},
	{
		name: "nbo_ma1_pbe_svp", series: series61, version: "6.1.0",
		out:               "corpus/6.1/nbo_ma1_pbe-svp.out",
		inp:               "corpus/6.1/nbo_ma1_pbe-svp.inp",
		runTypes:          []inputparse.RunType{inputparse.RunTypeSP},
		terminated:        true,
		nprocs:            8,
		geometriesAtLeast: 1, scfItersAtLeast: 14,
		finalSP: fp(-422.12811548),
	},
	{
		name: "neb_ci_hcn_hnc_xtb", series: series61, version: "6.1.1",
		out:          "corpus/6.1/neb-ci_hcn-hnc_xtb.out",
		inp:          "corpus/6.1/neb-ci_hcn-hnc_xtb.inp",
		runTypes:     []inputparse.RunType{inputparse.RunTypeNEBCI},
		terminated:   true,
		nebConverged: true,
		// The endpoint pre-optimizations print the plain opt banner; the
		// runner gates those out via RequestsNEBBand.
		optConverged:      true,
		geometriesAtLeast: 7,
		finalSP:           fp(-5.47215989),
	},
	{
		name: "opt_freq_ma1_r2scan3c", series: series61, version: "6.1.0",
		out: "corpus/6.1/opt-freq_ma1_r2scan3c.out",
		inp: "corpus/6.1/opt-freq_ma1_r2scan3c.inp",
		// TightOpt implies OPT, which inputparse appends after the
		// explicit Freq keyword — hence the order.
		runTypes:          []inputparse.RunType{inputparse.RunTypeFreq, inputparse.RunTypeOpt},
		terminated:        true,
		optConverged:      true,
		nprocs:            8,
		geometriesAtLeast: 10, scfItersAtLeast: 80,
		finalSP:   fp(-422.88693549),
		freqCount: 54, imaginary: ip(0), hessBlocks: 1,
		zpe: fp(0.14225975), enthalpy: fp(-422.73505219), gibbs: fp(-422.77823438),
	},
	{
		// A genuine transition state: one imaginary mode in the last of
		// two Hessian blocks.
		name: "optts_ma2_r1_r2scan3c", series: series61, version: "6.1.0",
		out:               "corpus/6.1/optts_ma2-r1_r2scan3c_2_009.out",
		inp:               "corpus/6.1/optts_ma2-r1_r2scan3c_2_009.inp",
		runTypes:          []inputparse.RunType{inputparse.RunTypeOptTS, inputparse.RunTypeFreq},
		terminated:        true,
		optConverged:      true,
		nprocs:            8,
		geometriesAtLeast: 37, scfItersAtLeast: 400,
		finalSP:   fp(-3096.40500683),
		freqCount: 105, imaginary: ip(1), hessBlocks: 2,
		zpe: fp(0.27768500), enthalpy: fp(-3096.10831405), gibbs: fp(-3096.17260862),
	},
	{
		name: "surfscan_h2co_xtb", series: series61, version: "6.1.1",
		out:               "corpus/6.1/surfscan_h2co_xtb.out",
		inp:               "corpus/6.1/surfscan_h2co_xtb.inp",
		runTypes:          []inputparse.RunType{inputparse.RunTypeOpt},
		terminated:        true,
		optConverged:      true, // one banner per relaxed-scan point
		geometriesAtLeast: 81,
		finalSP:           fp(-6.98443149),
	},
	{
		name: "surfscan2d_h2co_xtb", series: series61, version: "6.1.1",
		out:               "corpus/6.1/surfscan2d_h2co_xtb.out",
		inp:               "corpus/6.1/surfscan2d_h2co_xtb.inp",
		runTypes:          []inputparse.RunType{inputparse.RunTypeOpt},
		terminated:        true,
		optConverged:      true,
		geometriesAtLeast: 341,
		finalSP:           fp(-7.06196057),
	},
	{
		// Hand-built scan fixture with no version banner and no geometry
		// blocks — it exercises the FSPE + termination path on a file
		// that has nothing else in it.
		name: "surfscan2d_h2o_xtb", series: seriesUnknown,
		out:        "corpus/unversioned/surfscan2d_h2o_xtb.out",
		inp:        "corpus/unversioned/surfscan2d_h2o_xtb.inp",
		runTypes:   []inputparse.RunType{inputparse.RunTypeOpt},
		terminated: true,
		finalSP:    fp(-4.99660000),
	},
	{
		name: "surfscan3d_h2o_xtb", series: seriesUnknown,
		out:        "corpus/unversioned/surfscan3d_h2o_xtb.out",
		inp:        "corpus/unversioned/surfscan3d_h2o_xtb.inp",
		runTypes:   []inputparse.RunType{inputparse.RunTypeOpt},
		terminated: true,
		finalSP:    fp(-4.93215000),
	},
}

func TestCorpusRealOutputs(t *testing.T) {
	covered := map[series]int{}
	for _, tc := range corpusCases {
		t.Run(tc.name, func(t *testing.T) {
			path, ok := findFixture(t, filepath.Join("testdata", tc.out))
			if !ok {
				if requireCorpus() {
					t.Fatalf("fixture missing and DFTSTREAM_REQUIRE_CORPUS is set: %s", tc.out)
				}
				t.Skipf("fixture not in this checkout: %s", tc.out)
			}
			run := parseFile(t, path)

			if run.orcaVersion != tc.version {
				t.Errorf("orcaVersion = %q, want %q", run.orcaVersion, tc.version)
			}
			if got := seriesOf(run.orcaVersion); got != tc.series {
				t.Errorf("series = %q, want %q", got, tc.series)
			}
			if run.terminated != tc.terminated {
				t.Errorf("terminatedNormally = %v, want %v", run.terminated, tc.terminated)
			}
			if run.optConverged != tc.optConverged {
				t.Errorf("optConverged = %v, want %v", run.optConverged, tc.optConverged)
			}
			if run.nebConverged != tc.nebConverged {
				t.Errorf("nebConverged = %v, want %v", run.nebConverged, tc.nebConverged)
			}
			if run.nprocs != tc.nprocs {
				t.Errorf("nprocs = %d, want %d", run.nprocs, tc.nprocs)
			}
			if run.geometries < tc.geometriesAtLeast {
				t.Errorf("geometries = %d, want >= %d", run.geometries, tc.geometriesAtLeast)
			}
			if run.scfIters < tc.scfItersAtLeast {
				t.Errorf("scfIters = %d, want >= %d", run.scfIters, tc.scfItersAtLeast)
			}
			checkEnergy(t, "finalSP", run.finalSP, tc.finalSP)
			checkEnergy(t, "zpe", run.zpe, tc.zpe)
			checkEnergy(t, "enthalpy", run.enthalpy, tc.enthalpy)
			checkEnergy(t, "gibbs", run.gibbs, tc.gibbs)
			if run.freqCount != tc.freqCount {
				t.Errorf("freqCount = %d, want %d", run.freqCount, tc.freqCount)
			}
			if run.hessBlocks != tc.hessBlocks {
				t.Errorf("hessBlocks = %d, want %d", run.hessBlocks, tc.hessBlocks)
			}
			switch {
			case tc.imaginary == nil && run.imaginary != nil:
				t.Errorf("imaginaryModes = %d, want none (no frequency section)", *run.imaginary)
			case tc.imaginary != nil && run.imaginary == nil:
				t.Errorf("imaginaryModes = none, want %d", *tc.imaginary)
			case tc.imaginary != nil && *run.imaginary != *tc.imaginary:
				t.Errorf("imaginaryModes = %d, want %d", *run.imaginary, *tc.imaginary)
			}
			checkClasses(t, run.classes(), tc.classes)
			covered[tc.series]++
		})
	}
	// A corpus that silently stopped covering a release line is worse
	// than no corpus: say so out loud, and under DFTSTREAM_REQUIRE_CORPUS
	// require every populated cell of the series matrix to have parsed at
	// least one real output. 5.x is a documented gap (see the file header):
	// no real full-run 5.x output exists in the corpus yet, so it is
	// deliberately absent from the required set.
	t.Logf("fixtures parsed by series: 5.x=%d 6.0=%d 6.1=%d unversioned=%d",
		covered[series5], covered[series60], covered[series61], covered[seriesUnknown])
	if requireCorpus() {
		for _, s := range []series{series60, series61} {
			if covered[s] == 0 {
				t.Errorf("series matrix cell %q has no parsed fixture", s)
			}
		}
	}
}

// ---------------------------------------------------------------------
// Failure-catalogue corpus (testdata/)
// ---------------------------------------------------------------------

type diagCase struct {
	// file is relative to testdata/.
	file    string
	series  series
	version string
	// classes are the diagnostics expected in emission order.
	classes []ErrorClass
	// excerptHas must appear in the first diagnostic's excerpt.
	excerptHas string
	terminated bool
	// optMaxCycles is the OptNotConvergedEvent signal; it must agree with
	// an opt_max_cycles diagnostic.
	optMaxCycles bool
}

var diagCases = []diagCase{{
	// Every fatal path also ends in ORCA's generic top-level abort, so
	// these fixtures carry a trailing `unknown` too. The specific class
	// outranking it is exactly the tie-break the runner applies.
	file: "orca5_scf_not_converged.out", series: series5, version: "5.0.4",
	classes:    []ErrorClass{ErrorClassSCFNotConverged, ErrorClassUnknown},
	excerptHas: "SCF NOT CONVERGED AFTER 125 CYCLES",
}, {
	file: "orca6_scf_not_converged.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassSCFNotConverged, ErrorClassUnknown},
	excerptHas: "the SCF has not converged",
}, {
	file: "orca6_out_of_memory.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassOutOfMemory, ErrorClassUnknown},
	excerptHas: "Not enough memory in RI-Trafo",
}, {
	file: "orca6_disk_or_scratch.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassDiskOrScratch, ErrorClassUnknown},
	excerptHas: "for writing in module",
}, {
	file: "orca6_geometry_exploded.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassGeometryExploded, ErrorClassUnknown},
	excerptHas: "failed to convert Cartesian to internal coordinates",
}, {
	file: "orca6_charge_mult_impossible.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassChargeMultImpossible},
	excerptHas: "-> impossible",
}, {
	file: "orca6_unstable_wavefunction.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassUnstableWavefunction, ErrorClassUnknown},
	excerptHas: "the wavefunction is unstable",
}, {
	file: "orca6_basis_or_ecp_missing.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassBasisOrECPMissing},
	excerptHas: "basis set was either not assigned",
}, {
	// A module dies mid-run and ORCA still prints its normal banner.
	file: "orca6_external_tool_failed.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassExternalToolFailed},
	excerptHas: "ORCA finished by error termination in CIS",
	terminated: true,
}, {
	file: "orca6_input_error.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassInputError},
	excerptHas: "could not impose initial constraints",
}, {
	file: "orca6_opt_max_cycles.out", series: series61, version: "6.1.0",
	classes:      []ErrorClass{ErrorClassOptMaxCycles},
	excerptHas:   "reached the maximum",
	terminated:   true,
	optMaxCycles: true,
}, {
	file: "orca6_unknown_abort.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassUnknown},
	excerptHas: "ORCA finished with error return",
}, {
	// The false-positive guard: every line here is text a healthy ORCA
	// run prints that a naive rule would read as a failure.
	file: "orca6_clean_near_misses.out", series: series61, version: "6.1.0",
	terminated: true,
}, {
	// ORCA reconverged the unstable solution and finished. The parser
	// still reports it; the runner's verdict drops it (see
	// TestFinalStatusDropsRecoveredDiagnosisOnCleanRun).
	file: "orca6_recovered_instability.out", series: series61, version: "6.1.0",
	classes:    []ErrorClass{ErrorClassUnstableWavefunction},
	excerptHas: "the wavefunction is unstable",
	terminated: true,
}}

func TestCorpusDiagnostics(t *testing.T) {
	for _, tc := range diagCases {
		t.Run(strings.TrimSuffix(tc.file, ".out"), func(t *testing.T) {
			run := parseFile(t, filepath.Join("testdata", tc.file))

			if run.orcaVersion != tc.version {
				t.Errorf("orcaVersion = %q, want %q", run.orcaVersion, tc.version)
			}
			if got := seriesOf(run.orcaVersion); got != tc.series {
				t.Errorf("series = %q, want %q", got, tc.series)
			}
			if run.terminated != tc.terminated {
				t.Errorf("terminatedNormally = %v, want %v", run.terminated, tc.terminated)
			}
			if run.optMaxCycles != tc.optMaxCycles {
				t.Errorf("optMaxCycles = %v, want %v", run.optMaxCycles, tc.optMaxCycles)
			}
			checkClasses(t, run.classes(), tc.classes)
			if tc.excerptHas == "" {
				return
			}
			if len(run.diagnostics) == 0 {
				t.Fatalf("no diagnostic emitted, want excerpt containing %q", tc.excerptHas)
			}
			if ex := run.diagnostics[0].Excerpt; !strings.Contains(ex, tc.excerptHas) {
				t.Errorf("excerpt does not contain %q:\n%s", tc.excerptHas, ex)
			}
			if n := len(run.diagnostics[0].Excerpt); n > excerptMaxBytes {
				t.Errorf("excerpt is %d bytes, cap is %d", n, excerptMaxBytes)
			}
		})
	}
}

// TestCorpusDiagnosticsCoverEveryClass keeps the catalogue honest: a class
// added to the enum without a fixture is a class nothing tests.
func TestCorpusDiagnosticsCoverEveryClass(t *testing.T) {
	seen := map[ErrorClass]bool{}
	for _, tc := range diagCases {
		for _, c := range tc.classes {
			seen[c] = true
		}
	}
	for _, c := range AllErrorClasses {
		if !seen[c] {
			t.Errorf("no testdata fixture produces error class %q", c)
		}
	}
}

// TestErrorClassValuesMatchSchema pins the wire values. They are the
// contract with db/convex/schema.ts's ERROR_CLASS; changing one silently
// re-labels every historical run in the dashboard.
func TestErrorClassValuesMatchSchema(t *testing.T) {
	want := []string{
		"charge_mult_impossible", "basis_or_ecp_missing", "out_of_memory",
		"disk_or_scratch", "unstable_wavefunction", "scf_not_converged",
		"geometry_exploded", "opt_max_cycles", "external_tool_failed",
		"input_error", "unknown",
	}
	if len(AllErrorClasses) != len(want) {
		t.Fatalf("AllErrorClasses has %d members, want %d", len(AllErrorClasses), len(want))
	}
	for i, c := range AllErrorClasses {
		if c.String() != want[i] {
			t.Errorf("AllErrorClasses[%d] = %q, want %q", i, c, want[i])
		}
	}
}

// TestErrorClassSeverityIsATotalOrder guards the tie-break the runner
// relies on to pick one class out of several.
func TestErrorClassSeverityIsATotalOrder(t *testing.T) {
	for i, a := range AllErrorClasses {
		if a.MoreSevereThan(a) {
			t.Errorf("%q is more severe than itself", a)
		}
		if !a.MoreSevereThan("") {
			t.Errorf("%q should outrank the empty class", a)
		}
		if ErrorClass("").MoreSevereThan(a) {
			t.Errorf("the empty class should never outrank %q", a)
		}
		for _, b := range AllErrorClasses[i+1:] {
			if !a.MoreSevereThan(b) {
				t.Errorf("%q should be more severe than %q", a, b)
			}
			if b.MoreSevereThan(a) {
				t.Errorf("%q should not be more severe than %q", b, a)
			}
		}
	}
	// A class this build has never heard of must never displace a known
	// diagnosis.
	future := ErrorClass("some_future_class")
	if future.MoreSevereThan(ErrorClassUnknown) {
		t.Errorf("an unrecognised class outranked %q", ErrorClassUnknown)
	}
}

// TestInputEchoNeverTripsAClass is the guard for the one input the parser
// cannot trust: the user's own file, echoed verbatim near the top of every
// output.
func TestInputEchoNeverTripsAClass(t *testing.T) {
	const log = `                         Program Version 6.1.0  -  RELEASE  -

================================================================================
                                       INPUT FILE
================================================================================
NAME = job.inp
|  1> # previous run hit: Error : multiplicity (1) is odd -> impossible
|  2> # and before that: not enough memory, please increase MaxCore
|  3> ! HF def2-SVP
|  4>                          ****END OF INPUT****
================================================================================

FINAL SINGLE POINT ENERGY      -75.955000000000
                             ****ORCA TERMINATED NORMALLY****
TOTAL RUN TIME: 0 days 0 hours 0 minutes 1 seconds 0 msec
`
	for _, e := range collect(t, log) {
		if d, ok := e.(DiagnosticEvent); ok {
			t.Errorf("input echo produced diagnostic %q:\n%s", d.Class, d.Excerpt)
		}
	}
}

// TestSectionPreambleIsBounded pins the fix for a table shape the row
// regex does not recognise. Before it, such a section consumed the whole
// rest of the output and every later landmark — the final energy, the
// termination banner, the failure diagnosis — was lost. ORCA 6.1's
// absorption spectrum is exactly that case: its rows are labelled
// "0-1A -> 1-1A", not by a bare state index.
func TestSectionPreambleIsBounded(t *testing.T) {
	var b strings.Builder
	b.WriteString("Program Version 6.1.0\n")
	b.WriteString("ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS\n")
	b.WriteString("     Transition      Energy     Wavelength fosc\n")
	for i := 0; i < 200; i++ {
		b.WriteString("  0-1A  ->  1-1A    2.699023   21769.1   459.4   0.497988006\n")
	}
	b.WriteString("FINAL SINGLE POINT ENERGY      -812.199174088665\n")
	b.WriteString("****ORCA TERMINATED NORMALLY****\n")
	b.WriteString("TOTAL RUN TIME: 0 days 0 hours 0 minutes 1 seconds 0 msec\n")

	var sawFinal, sawEnd bool
	for _, e := range collect(t, b.String()) {
		switch ev := e.(type) {
		case FinalSPEvent:
			sawFinal = true
			if math.Abs(ev.Energy-(-812.199174088665)) > 1e-9 {
				t.Errorf("final SP = %v", ev.Energy)
			}
		case RunEndEvent:
			sawEnd = ev.Normal
		}
	}
	if !sawFinal {
		t.Error("final single point energy was swallowed by the unrecognised table")
	}
	if !sawEnd {
		t.Error("termination banner was swallowed by the unrecognised table")
	}
}

// orca6AbsorptionLog is the absorption block ORCA 6.0.1 actually prints,
// copied column-for-column off a real TD-DFT output. Two things changed
// from 5.x: the bare state index became a transition label
// ("0-1A -> 1-1A"), and an eV column was inserted ahead of the cm⁻¹ one,
// shifting every later field one to the right.
const orca6AbsorptionLog = `Program Version 6.0.1 -  RELEASE  -

         ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS
----------------------------------------------------------------------------------
     Transition      Energy     Energy  Wavelength fosc(D2)      D2        DX
                      (eV)      (cm-1)    (nm)                 (au**2)    (au)
----------------------------------------------------------------------------------
  0-1A  ->  1-1A    2.611722   21065.0   474.7   0.929969438  14.53395  -3.55846
  0-1A  ->  2-1A    3.227822   26034.1   384.1   0.049137555   0.62136   0.75206
  0-1A  ->  3-1A    3.611109   29125.6   343.3   0.166533223   1.88236  -1.35428

----------------------------------------------------------------------------------
         ABSORPTION SPECTRUM VIA TRANSITION VELOCITY DIPOLE MOMENTS
----------------------------------------------------------------------------------
     Transition      Energy     Energy  Wavelength fosc(P2)      P2        PX
                      (eV)      (cm-1)    (nm)                 (au**2)    (au)
----------------------------------------------------------------------------------
  0-1A  ->  1-1A    2.611722   21065.0   474.7   0.491386014   0.07074   0.24358

FINAL SINGLE POINT ENERGY      -812.199174088665
****ORCA TERMINATED NORMALLY****
`

// TestORCA6AbsorptionSpectrumIsParsed pins the ROWS, not just the
// survival of the rest of the file.
//
// TestSectionPreambleIsBounded above stopped an unrecognised table from
// swallowing every later landmark, but it left the table's own contents
// on the floor: reAbsRow only ever matched ORCA 5.x's bare state index,
// so on ORCA 6 output the section produced zero rows and the run's
// excited states silently did not exist. Every one of the 100 outputs in
// the developer corpus that has an absorption spectrum is ORCA 6 and hit
// exactly this.
func TestORCA6AbsorptionSpectrumIsParsed(t *testing.T) {
	var excited *ExcitedStatesEvent
	for _, e := range collect(t, orca6AbsorptionLog) {
		if ev, ok := e.(ExcitedStatesEvent); ok {
			excited = &ev
		}
	}
	if excited == nil {
		t.Fatal("no ExcitedStatesEvent: ORCA 6 absorption rows were dropped")
	}
	// Only the ELECTRIC dipole table is a landmark; the VELOCITY table
	// that follows it must not add a fourth row.
	if len(excited.Items) != 3 {
		t.Fatalf("expected 3 excited states, got %d: %+v", len(excited.Items), excited.Items)
	}
	want := []ExcitedState{
		{Index: 1, EnergyEV: 2.611722, EnergyCM: 21065.0, WavelengthNM: 474.7, OscStrength: 0.929969438},
		{Index: 2, EnergyEV: 3.227822, EnergyCM: 26034.1, WavelengthNM: 384.1, OscStrength: 0.049137555},
		{Index: 3, EnergyEV: 3.611109, EnergyCM: 29125.6, WavelengthNM: 343.3, OscStrength: 0.166533223},
	}
	for i, w := range want {
		got := excited.Items[i]
		if got.Index != w.Index {
			t.Errorf("row %d: index = %d, want %d", i, got.Index, w.Index)
		}
		// The eV column is read directly now, not derived from cm⁻¹:
		// ORCA prints both and its own value is the one to keep.
		for _, f := range []struct {
			name     string
			got, exp float64
		}{
			{"energyEV", got.EnergyEV, w.EnergyEV},
			{"energyCM", got.EnergyCM, w.EnergyCM},
			{"wavelengthNM", got.WavelengthNM, w.WavelengthNM},
			{"fosc", got.OscStrength, w.OscStrength},
		} {
			if math.Abs(f.got-f.exp) > 1e-6 {
				t.Errorf("row %d: %s = %v, want %v", i, f.name, f.got, f.exp)
			}
		}
	}
}

// TestORCA5AbsorptionSpectrumStillParses guards the older layout against
// the ORCA 6 branch added above: 5.x has no transition label and no eV
// column, so its cm⁻¹ value sits where 6.x puts eV.
func TestORCA5AbsorptionSpectrumStillParses(t *testing.T) {
	log := `Program Version 5.0.4 -  RELEASE  -

         ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS
-----------------------------------------------------------------------------
State   Energy  Wavelength   fosc         T2         TX        TY        TZ
        (cm-1)   (nm)                   (au**2)     (au)      (au)      (au)
-----------------------------------------------------------------------------
   1   38440.7    260.1   0.030000000   0.00000000  -0.00000   0.00000   0.00000
   2   41234.5    242.5   0.010000000   0.00000000  -0.00000   0.00000   0.00000

****ORCA TERMINATED NORMALLY****
`
	var excited *ExcitedStatesEvent
	for _, e := range collect(t, log) {
		if ev, ok := e.(ExcitedStatesEvent); ok {
			excited = &ev
		}
	}
	if excited == nil {
		t.Fatal("no ExcitedStatesEvent for ORCA 5 layout")
	}
	if len(excited.Items) != 2 {
		t.Fatalf("expected 2 excited states, got %d: %+v", len(excited.Items), excited.Items)
	}
	first := excited.Items[0]
	if first.Index != 1 {
		t.Errorf("index = %d, want 1", first.Index)
	}
	if math.Abs(first.EnergyCM-38440.7) > 1e-6 {
		t.Errorf("energyCM = %v, want 38440.7", first.EnergyCM)
	}
	if math.Abs(first.WavelengthNM-260.1) > 1e-6 {
		t.Errorf("wavelengthNM = %v, want 260.1", first.WavelengthNM)
	}
	if math.Abs(first.OscStrength-0.03) > 1e-9 {
		t.Errorf("fosc = %v, want 0.03", first.OscStrength)
	}
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

func checkEnergy(t *testing.T, name string, got, want *float64) {
	t.Helper()
	switch {
	case want == nil && got != nil:
		t.Errorf("%s = %.8f, want none", name, *got)
	case want != nil && got == nil:
		t.Errorf("%s = none, want %.8f", name, *want)
	case want != nil && math.Abs(*got-*want) > 1e-8:
		t.Errorf("%s = %.8f, want %.8f", name, *got, *want)
	}
}

func checkClasses(t *testing.T, got, want []ErrorClass) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("error classes = %v, want %v", got, want)
		return
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("error classes = %v, want %v", got, want)
			return
		}
	}
}

// checkRunTypes is used by TestCorpusRunTypes below; kept separate so the
// input-file assertion can skip on its own when only the .out is kept.
func checkRunTypes(t *testing.T, got, want []inputparse.RunType) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("runTypes = %v, want %v", got, want)
		return
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("runTypes = %v, want %v", got, want)
			return
		}
	}
}

// TestCorpusRunTypes checks that each fixture's input file still
// classifies as the run type the corpus claims — the label under which
// every other expectation in the table is read.
func TestCorpusRunTypes(t *testing.T) {
	for _, tc := range corpusCases {
		if tc.inp == "" || len(tc.runTypes) == 0 {
			continue
		}
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join("testdata", tc.inp)
			text, err := os.ReadFile(path)
			if errors.Is(err, fs.ErrNotExist) {
				if requireCorpus() {
					t.Fatalf("fixture missing and DFTSTREAM_REQUIRE_CORPUS is set: %s", tc.inp)
				}
				t.Skipf("fixture not in this checkout: %s", tc.inp)
			} else if err != nil {
				t.Fatalf("read %s: %v", path, err)
			}
			checkRunTypes(t, inputparse.Parse(string(text)).RunTypes, tc.runTypes)
		})
	}
}

// An MECP run prints a sentence about vibrational frequencies before it
// prints either of its two Hessians:
//
//	The VIBRATIONAL FREQUENCIES include only those modes parallel to the crossing hyperline.
//
// The landmark matched with Contains, so that sentence opened a
// frequencies section and bumped hessCount. The section then timed out
// against its preamble budget and emitted nothing — but the counter had
// already moved, so the two real blocks came back as Hessian 2 and 3
// instead of 1 and 2, and the UI's Hessian history pointed at the wrong
// one. All three spellings appear verbatim in real ORCA 6 MECP output.
func TestMECPProseIsNotAHessian(t *testing.T) {
	log := `Program Version 6.1.0
First we'll calculate the Hessian for the first PES,
The VIBRATIONAL FREQUENCIES include only those modes parallel to the crossing hyperline.
Be careful with your results!

VIBRATIONAL FREQUENCIES
-----------------------
     6:     100.00 cm**-1
     7:     200.00 cm**-1

Something else entirely

VIBRATIONAL FREQUENCIES PES2
---------------------------
     6:     300.00 cm**-1

Something else entirely
****ORCA TERMINATED NORMALLY****
`
	var idx []int
	for _, e := range collect(t, log) {
		if ev, ok := e.(FrequenciesEvent); ok {
			idx = append(idx, ev.HessIdx)
		}
	}
	if len(idx) != 2 {
		t.Fatalf("got %d frequency blocks, want 2 (indices %v)", len(idx), idx)
	}
	if idx[0] != 1 || idx[1] != 2 {
		t.Errorf("HessIdx = %v, want [1 2] — the prose line was counted as a Hessian", idx)
	}
}
