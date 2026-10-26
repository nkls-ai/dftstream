package parser

import "regexp"

// Landmark prefixes — checked with strings.Contains for tolerance to
// leading whitespace.
const (
	lmInputFileHeader    = "INPUT FILE"
	lmInputFileEnd       = "END OF INPUT"
	lmGeomOptCycle       = "GEOMETRY OPTIMIZATION CYCLE"
	lmCoordsAngstrom     = "CARTESIAN COORDINATES (ANGSTROEM)"
	lmScfTableHeader     = "D-I-I-S"
	lmScfConverged       = "SCF CONVERGED AFTER"
	lmTotalEnergy        = "Total Energy       :"
	lmNuclearRepulsion   = "Nuclear Repulsion"
	lmElectronicEnergy   = "Electronic Energy"
	lmOneElectronEnergy  = "One Electron Energy"
	lmTwoElectronEnergy  = "Two Electron Energy"
	lmFinalSP            = "FINAL SINGLE POINT ENERGY"
	lmVibFreqs           = "VIBRATIONAL FREQUENCIES"
	lmOptConverged       = "THE OPTIMIZATION HAS CONVERGED"
	lmOptNotConverged    = "The optimization did not converge"
	lmMECPHeader         = "MINIMUM ENERGY CROSSING POINT"
	lmMECPOptimization   = "MECP OPTIMIZATION"
	lmMECPConverged      = "THE MECP OPTIMIZATION HAS CONVERGED"
	lmNEBHeader          = "NEB OPTIMIZATION" // section header; matched trimmed-equal, not Contains
	lmNEBConverged       = "THE NEB OPTIMIZATION HAS CONVERGED"
	lmIRSpectrum         = "IR SPECTRUM"
	lmOrcaTerminatedOk   = "ORCA TERMINATED NORMALLY"
	lmZeroPointEnergy    = "Zero point energy"
	lmS2Expectation      = "Expectation value of <S**2>"
	lmS2Ideal            = "Ideal value S*(S+1)"
	lmTotalEnthalpy      = "Total enthalpy"
	lmEntropyCorrection  = "Total entropy correction"
	lmFinalGibbs         = "Final Gibbs free energy"
	lmGMinusE            = "G-E(el)"
	lmTotalRunTime       = "TOTAL RUN TIME:"
	lmProgramVersion     = "Program Version"
	lmParallelMPIProc    = "Program running with"
	lmInputDirectiveOpen = "%pal"
	lmMaxcoreLine        = "%maxcore"

	// TD-DFT
	lmAbsSpectrum = "ABSORPTION SPECTRUM VIA TRANSITION ELECTRIC DIPOLE MOMENTS"
	lmTDDFTStates = "TD-DFT/TDA EXCITED STATES"
	lmCISStates   = "CIS-EXCITED STATES"

	// NMR
	lmNMRShielding = "CHEMICAL SHIELDING"
)

// Failure landmarks. Unlike the data landmarks above these are matched
// against the UPPER-CASED line (handleLandmark already has it), so the
// constants are upper case. diagnostics.go maps each to an ErrorClass;
// the text is taken verbatim from ORCA 6.1's own message catalogue
// (`strings` on the orca/orca_leanscf binaries) so a rule keys on what
// ORCA actually prints, not on a paraphrase.
const (
	// SCF convergence failure. The banner is unchanged between ORCA 5.x
	// and 6.x; the "has diverged"/"has not converged"/"Convergence
	// failure" wordings come from the 6.x LeanSCF solver.
	lmScfNotConvergedBanner = "SCF NOT CONVERGED AFTER"
	lmScfNotConvergedImage  = "SCF NOT CONVERGED FOR IMAGE"
	lmScfHasNotConverged    = "THE SCF HAS NOT CONVERGED"
	lmScfHasDiverged        = "THE SCF HAS DIVERGED"
	lmScfConvergenceFailure = "ERROR (ORCA_LEANSCF): CONVERGENCE FAILURE"

	// Memory exhaustion (%maxcore too small / node out of RAM). Matching
	// the bare word "maxcore" would hit every input echo, so the rule
	// keys on ORCA's remedy sentence instead.
	lmNotEnoughMemory     = "NOT ENOUGH MEMORY"
	lmInsufficientMemory  = "INSUFFICIENT MEMORY"
	lmPleaseIncreaseMaxCo = "PLEASE INCREASE MAXCORE"
	lmOutOfMemoryBanner   = "OUT OF MEMORY"
	lmBadAlloc            = "BAD_ALLOC"
	lmCannotAllocate      = "CANNOT ALLOCATE MEMORY"

	// Scratch directory / disk failures. "scratch" on its own is far too
	// common in normal output (NBO prints "scratch memory used by NBO was
	// N words" on every run), so the rules key on the failure sentence.
	lmNoSpaceLeft        = "NO SPACE LEFT ON DEVICE"
	lmDiskQuotaExceeded  = "DISK QUOTA EXCEEDED"
	lmOpenForWriting     = "FOR WRITING IN MODULE"
	lmMaxBytesDisk       = "ERROR MAXBYTESDISK"
	lmInputOutputError   = "INPUT/OUTPUT ERROR"
	lmScratchDirNotFound = "SCRATCH DIRECTORY DOES NOT EXIST"

	// A geometry that blew apart: ORCA can no longer build or convert the
	// redundant internal coordinates for the structure. Counting
	// "fragment" would be hopeless — normal outputs print it thousands of
	// times (Mulliken fragment charges, NEB fragment masses, …).
	lmCartToInternalFailed = "FAILED TO CONVERT CARTESIAN TO INTERNAL COORDINATES"
	lmCartToInternalError  = "ERROR CONVERTING CARTESIAN INTO INTERNAL COORDINATES"
	lmInternalCoordsBroke  = "INTERNAL COORDINATES AND GRADIENT DIDN'T WORK"

	// Charge / multiplicity impossible for the electron count.
	lmMultImpossible  = "-> IMPOSSIBLE"
	lmMultError       = "ERROR : MULTIPLICITY"
	lmElectronCountEr = "ERROR : NUMBER OF ELECTRONS"

	// Unstable HF/KS wavefunction: the stability analysis found negative
	// eigenvalues of the stability matrix and the reconvergence attempts
	// (if any) failed. The per-try "The wavefunction in try 1/ 2 is
	// unstable" line is deliberately NOT matched — that one is followed
	// by a successful reconvergence in the runs that recover.
	lmWavefunctionUnstable = "THE WAVEFUNCTION IS UNSTABLE"
	lmStillUnstable        = "WAVEFUNCTION SEEMS TO BE STILL UNSTABLE"
	lmStabilityNoConverge  = "STABILITY EQUATIONS DID NOT CONVERGE"

	// Missing basis set or ECP.
	lmBasisNotAssigned = "BASIS SET WAS EITHER NOT ASSIGNED OR NOT AVAILABLE"
	lmNoBasisDefined   = "NO BASIS SET IS DEFINED"
	lmUnknownBasisName = "UNKNOWN BASISSET NAME IN"
	lmECPNotAvailable  = "REQUESTED ECP NOT AVAILABLE FOR ELEMENT"

	// An auxiliary ORCA module or external program failed. ORCA names the
	// module it died in, which is the single most common real-world
	// failure line in a batch of outputs.
	lmErrorTermination  = "ORCA FINISHED BY ERROR TERMINATION IN"
	lmProgramReturnsErr = "PROGRAM RETURNS AN ERROR"
	lmCannotBeExecuted  = "CANNOT BE EXECUTED"

	// Input errors — the run never got off the ground.
	lmInputErrorBanner    = "INPUT ERROR"
	lmUnrecognizedKeyword = "UNRECOGNIZED OR DUPLICATED KEYWORD"
	lmAbortInputError     = "ABORTING DUE TO INPUT ERROR"
	lmOrcaMainError       = "ERROR (ORCA_MAIN)"
	lmCheckYourInput      = "PLEASE CHECK YOUR INPUT"

	// Top-level abort with no more specific message anywhere in the
	// output — classified `unknown`, but still worth an excerpt.
	lmOrcaErrorReturn = "ORCA FINISHED WITH ERROR RETURN"
)

// reAtom matches a cartesian-coordinate row, e.g.
//
//	"  O     -0.955785   -1.270371   -2.538008"
var reAtom = regexp.MustCompile(`^\s*([A-Z][a-z]?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$`)

// reScfIter matches an SCF DIIS iteration row, e.g.
//
//	"    1    -974.2592206696339190     0.00e+00  3.77e-03  7.50e-02  1.45e-01  0.700   2.1"
//
// Roothan rows also exist with similar shape. We accept any row that starts
// with an integer iteration index and an energy float in scientific or
// decimal form; remaining columns are optional.
var reScfIter = regexp.MustCompile(
	`^\s*(\d+)\s+(-?\d+\.\d+)` +
		`(?:\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))?` + // delta
		`(?:\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))?` + // rmsdp
		`(?:\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?))?` + // maxdp
		`.*?\s+(\d+\.\d+)\s*$`)

// reFreqRow matches a vibrational frequency row, e.g.
//
//	"     6:     -65.98 cm**-1  ***imaginary mode***"
var reFreqRow = regexp.MustCompile(`^\s*(\d+):\s+(-?\d+\.\d+)\s+cm\*\*-1(.*)$`)

// reIRRow matches an IR spectrum row, e.g.
//
//	"  6:     38.47   0.001004    5.07  0.008145  (-0.006908  0.089063  0.012839)"
var reIRRow = regexp.MustCompile(`^\s*(\d+):\s+\S+\s+\S+\s+(\d+\.\d+)\s+`)

// reCycle matches the cycle number out of the OPT header line.
var reCycle = regexp.MustCompile(`GEOMETRY OPTIMIZATION CYCLE\s+(\d+)`)

// reScfConverged extracts the iteration count from "SCF CONVERGED AFTER  16 CYCLES".
var reScfConverged = regexp.MustCompile(`SCF CONVERGED AFTER\s+(\d+)\s+CYCLES`)

// reTotalEnergy extracts the value in Eh from "Total Energy       :    -974.75 Eh ..."
var reTotalEnergy = regexp.MustCompile(`Total Energy\s*:\s*(-?\d+\.\d+)\s*Eh`)

// reFinalSP extracts the value after FINAL SINGLE POINT ENERGY.
var reFinalSP = regexp.MustCompile(`FINAL SINGLE POINT ENERGY\s+(-?\d+\.\d+)`)

// reNumeric extracts the first float on a line (used for Nuclear Repulsion etc.).
var reNumericEh = regexp.MustCompile(`(-?\d+\.\d+)\s*Eh`)

// Thermochemistry rows, e.g.
//
//	"Zero point energy                ...      0.008608 Eh       5.40 kcal/mol"
//	"Final Gibbs free energy          ...   -974.190461 Eh"
//	"G-E(el)                          ...      0.045678 Eh      28.66 kcal/mol"
//
// All values taken in Eh; the trailing kcal/mol column (where present) is
// derived and ignored.
var (
	reZeroPointEnergy   = regexp.MustCompile(`Zero point energy\s*\.+\s*(-?\d+\.\d+)\s*Eh`)
	reS2Expectation     = regexp.MustCompile(`Expectation value of <S\*\*2>\s*:\s*(-?\d+\.\d+)`)
	reS2Ideal           = regexp.MustCompile(`Ideal value S\*\(S\+1\) for S=\S+\s*:\s*(-?\d+\.\d+)`)
	reTotalEnthalpy     = regexp.MustCompile(`Total enthalpy\s*\.+\s*(-?\d+\.\d+)\s*Eh`)
	reEntropyCorrection = regexp.MustCompile(`Total entropy correction\s*\.+\s*(-?\d+\.\d+)\s*Eh`)
	reFinalGibbs        = regexp.MustCompile(`Final Gibbs free energy\s*\.+\s*(-?\d+\.\d+)\s*Eh`)
	reGMinusE           = regexp.MustCompile(`G-E\(el\)\s*\.+\s*(-?\d+\.\d+)\s*Eh`)
)

// reRunTime matches "TOTAL RUN TIME: 0 days 0 hours 42 minutes 42 seconds 574 msec".
var reRunTime = regexp.MustCompile(
	`TOTAL RUN TIME:\s+(\d+)\s+days\s+(\d+)\s+hours\s+(\d+)\s+minutes\s+(\d+)\s+seconds\s+(\d+)\s+msec`,
)

// reOrcaVersion matches "Program Version 6.1.0".
var reOrcaVersion = regexp.MustCompile(`Program Version\s+(\S+)`)

// reMPIProcs matches "Program running with N parallel MPI-processes".
var reMPIProcs = regexp.MustCompile(`Program running with\s+(\d+)\s+parallel`)

// reNMRRow matches a chemical shielding row, e.g.
//
//	"    0  C       162.1234       45.6789"
//
// Columns: AtomIdx  Element  Isotropic  Anisotropy
var reNMRRow = regexp.MustCompile(`^\s*(\d+)\s+([A-Z][a-z]?)\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)`)

// reAbsRow matches an ORCA 5.x absorption spectrum table row, e.g.
//
//	"    0       38440.7     260.1   0.000000000   0.00000000   -0.00000000    0.00000000    0.00000000"
//
// Columns: State  Energy(cm⁻¹)  Wavelength(nm)  fosc  T²  TX  TY  TZ
var reAbsRow = regexp.MustCompile(`^\s*(\d+)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+\.\d+)\s+`)

// reAbsRow6 matches the ORCA 6.x absorption spectrum row. ORCA 6 replaced
// the bare state index with a transition label and inserted an eV column
// ahead of the cm⁻¹ one, e.g.
//
//	"  0-1A  ->  1-1A    2.611722   21065.0   474.7   0.929969438  14.53395  -3.55846  -1.02825  -0.90224"
//
// Columns: Transition  Energy(eV)  Energy(cm⁻¹)  Wavelength(nm)  fosc(D2)  D2  DX  DY  DZ
//
// The label is "<initial>-<mult><irrep> -> <final>-<mult><irrep>"; the
// final state's leading integer is the state number that the TD-DFT
// "STATE n:" blocks use, which is what mergeExcitedStates joins on.
var reAbsRow6 = regexp.MustCompile(
	`^\s*\d+-\S+\s*->\s*(\d+)-\S+` +
		`\s+(-?\d+\.\d+)` + // energy, eV
		`\s+(-?\d+\.?\d*)` + // energy, cm-1
		`\s+(-?\d+\.?\d*)` + // wavelength, nm
		`\s+(-?\d+\.\d+)`) // fosc

// reOrbTransition matches an orbital transition line inside a TD-DFT state block, e.g.
//
//	"   137a ->  138a  :     0.698507 (c= 0.83577)"
var reOrbTransition = regexp.MustCompile(`^\s*(\d+[ab]?)\s*->\s*(\d+[ab]?)\s*:\s*(-?\d+\.\d+)`)

// reTDDFTStateHeader matches a state header like "STATE  1:  E=   0.119073 au   3.240 eV   26134.5 cm**-1"
var reTDDFTStateHeader = regexp.MustCompile(`STATE\s+(\d+):\s+E=\s*\S+\s+au\s+(\d+\.\d+)\s+eV\s+(\d+\.?\d*)\s+cm\*\*-1`)

const floatRe = `[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?`

var (
	reMECPPair = regexp.MustCompile(`(?i)(?:state|surface|e)\s*\(?\s*1\s*\)?[^\n]*?(` + floatRe + `)[^\n]*?(?:state|surface|e)\s*\(?\s*2\s*\)?[^\n]*?(` + floatRe + `)`)
	// State energies lead the line ("State 1 energy:", "E(1) = ..."). The
	// `^\s*` anchor keeps a gap line like "Energy gap (E2 - E1):  0.012"
	// from matching — there the "E1):" fragment looks like state 1 = number,
	// but it sits mid-line, not at the start.
	reMECPState1 = regexp.MustCompile(`(?i)^\s*(?:state|surface|e)\s*\(?\s*1\s*\)?\s*(?:energy)?\s*[:=]?\s*(` + floatRe + `)`)
	reMECPState2 = regexp.MustCompile(`(?i)^\s*(?:state|surface|e)\s*\(?\s*2\s*\)?\s*(?:energy)?\s*[:=]?\s*(` + floatRe + `)`)
)
