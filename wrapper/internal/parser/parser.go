package parser

import (
	"bufio"
	"context"
	"io"
	"strconv"
	"strings"
	"time"
)

// Parser turns an ORCA stdout stream into a sequence of Events.
//
// It is line-driven and tolerant: anything it doesn't recognise is
// ignored. A malformed section resets the state machine to idle rather
// than aborting.
type Parser struct {
	now func() time.Time
}

// New constructs a Parser. Pass nil for now to use time.Now.
func New(now func() time.Time) *Parser {
	if now == nil {
		now = time.Now
	}
	return &Parser{now: now}
}

type state int

const (
	stIdle state = iota
	stGeometry
	stScfTable
	stFrequencies
	stIRSpectrum
	stAbsSpectrum
	stTDDFTStates
	stNMRShielding
)

// lineOutcome tells the scan loop what to do after a state-specific
// consumer has seen a line.
type lineOutcome int

const (
	// lineConsumed: the line was fully handled; move to the next line.
	lineConsumed lineOutcome = iota
	// lineFallthrough: the line ended the section; run the global
	// landmark dispatch (and MECP capture) on this same line.
	lineFallthrough
	// lineAborted: an emit blocked on a canceled context; stop parsing.
	lineAborted
)

// parseRun is the mutable state of one Parse call. The state-specific
// line consumers and the global landmark dispatch live on it as methods;
// Parse's scan loop only sequences them.
type parseRun struct {
	p   *Parser
	ctx context.Context
	out chan<- Event

	st           state
	currentCycle int

	// preamble counts the lines a table section has tolerated before its
	// first data row. Section consumers accept decorative header lines
	// without limit otherwise, which turns a table ORCA prints in a shape
	// the row regex does not know into a black hole: the section swallows
	// the entire rest of the output, and every landmark after it —
	// FINAL SINGLE POINT ENERGY, the termination banner, the failure
	// diagnosis — is lost. Reset on entering a section.
	preamble int

	atoms           []Atom
	freqs           []Frequency
	pendingFreqs    []Frequency
	hessCount       int // VIBRATIONAL FREQUENCIES blocks seen so far
	pendingHessIdx  int // hessian ordinal of pendingFreqs
	irIntensities   map[int]float64
	excitedStates   []ExcitedState
	absSpectrumRows []ExcitedState
	currentTDState  *ExcitedState
	nmrShields      []NMRShield

	mecpActive             bool
	mecpState1, mecpState2 float64
	mecpHave1, mecpHave2   bool
	mecpEmittedCycle       map[int]bool

	runEndNormal    bool
	runEndWallclock time.Duration
	thermo          ThermoEvent
	thermoSeen      bool

	// <S**2> expectation seen on the previous lines, waiting for the
	// adjacent "Ideal value" row to emit the pair as one event.
	s2Pending     float64
	s2PendingSeen bool

	// Failure diagnosis (diagnostics.go). recent is a ring of the last
	// excerptLinesBefore lines — every line, consumed or not — so an
	// excerpt can quote what led up to the diagnosis. inInputEcho
	// suppresses classification while ORCA echoes the input file, where a
	// user's own comment could otherwise trip a rule. diagSeen keeps one
	// event per class so a run that prints "not enough memory" on every
	// pair does not flood the event log.
	recent      []string
	diagPending *diagnosticCapture
	diagSeen    map[ErrorClass]bool
	inInputEcho bool
	// landmarkAborted records that an emit from inside one of the landmark
	// switch's boolean case expressions (classifyDiagnostic,
	// captureThermo) blocked on a canceled context — a case expression
	// cannot return the abort itself.
	landmarkAborted bool
}

// Parse reads from r line by line and sends Events to out. It returns
// only when r is fully drained or ctx is canceled. It never closes out.
// Errors reading r are returned (other than io.EOF).
func (p *Parser) Parse(ctx context.Context, r io.Reader, out chan<- Event) error {
	sc := bufio.NewScanner(r)
	// ORCA prints long lines (especially in matrix dumps). 1 MiB is plenty.
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)

	run := &parseRun{
		p:                p,
		ctx:              ctx,
		out:              out,
		irIntensities:    map[int]float64{},
		mecpEmittedCycle: map[int]bool{},
		diagSeen:         map[ErrorClass]bool{},
		recent:           make([]string, 0, excerptLinesBefore),
	}

	for sc.Scan() {
		if run.handleLine(sc.Text()) == lineAborted {
			return ctx.Err()
		}
	}
	if !run.flushAtEOF() {
		return ctx.Err()
	}

	if err := sc.Err(); err != nil && err != io.EOF {
		return err
	}
	return nil
}

func (r *parseRun) emit(e Event) bool {
	select {
	case <-r.ctx.Done():
		return false
	case r.out <- e:
		return true
	}
}

func (r *parseRun) resetIdle() { r.st = stIdle }

// enterSection switches to a table-consuming state and arms its preamble
// budget.
func (r *parseRun) enterSection(st state) {
	r.st = st
	r.preamble = 0
}

// maxSectionPreamble is how many non-matching lines a table may print
// before its first data row. ORCA's widest header (title, rules, two
// column-name rows, blank lines) is well under this.
const maxSectionPreamble = 12

// preambleExhausted reports whether the current section has spent its
// budget of header lines without producing a data row, and resets the
// state machine when it has.
func (r *parseRun) preambleExhausted() bool {
	r.preamble++
	if r.preamble <= maxSectionPreamble {
		return false
	}
	r.resetIdle()
	return true
}

// handleLine sequences the three things every line goes through: the
// trailing context of an open failure excerpt (which must see every line,
// consumed or not), the state machine, and the recent-lines ring that
// feeds the next excerpt's leading context.
func (r *parseRun) handleLine(line string) lineOutcome {
	if !r.absorbDiagnostic(line) {
		return lineAborted
	}
	oc := r.dispatchLine(line)
	r.pushRecent(line)
	return oc
}

// dispatchLine runs the state-specific consumer first (they accumulate
// across many lines and have their own termination rules), then — unless
// the line was consumed — the global landmark dispatch and MECP capture.
func (r *parseRun) dispatchLine(line string) lineOutcome {
	var oc lineOutcome
	switch r.st {
	case stGeometry:
		oc = r.handleGeometryLine(line)
	case stScfTable:
		oc = r.handleScfTableLine(line)
	case stFrequencies:
		oc = r.handleFrequenciesLine(line)
	case stIRSpectrum:
		oc = r.handleIRSpectrumLine(line)
	case stNMRShielding:
		oc = r.handleNMRShieldingLine(line)
	case stAbsSpectrum:
		oc = r.handleAbsSpectrumLine(line)
	case stTDDFTStates:
		oc = r.handleTDDFTStatesLine(line)
	default:
		oc = lineFallthrough
	}
	if oc != lineFallthrough {
		return oc
	}

	if !r.handleLandmark(line, strings.ToUpper(line)) {
		return lineAborted
	}
	if r.mecpActive {
		if !r.captureMECPLine(line) {
			return lineAborted
		}
	}
	return lineConsumed
}

// flushAtEOF emits everything still in flight when the stream ends:
// in-progress geometry / frequency / NMR / excited-state sections, a
// partial thermochemistry section, and the run-end summary.
func (r *parseRun) flushAtEOF() bool {
	// A diagnosis in the last lines of a killed run never gets its full
	// trailing context — emit what was captured.
	if !r.flushDiagnostic() {
		return false
	}
	if !r.emitPendingGeometry() {
		return false
	}
	if len(r.freqs) > 0 {
		if !r.emit(FrequenciesEvent{
			base:    base{TS: r.p.now()},
			Items:   append([]Frequency(nil), r.freqs...),
			HessIdx: r.hessCount,
		}) {
			return false
		}
	}
	if !r.flushMECP() {
		return false
	}
	// Flush any pending frequencies that didn't get an IR section
	if !r.flushFreqs() {
		return false
	}
	// Flush a thermochemistry section that never reached its G-E(el) row
	// (truncated or killed run).
	if !r.flushThermo() {
		return false
	}
	if len(r.nmrShields) > 0 {
		if !r.emit(NMRShieldsEvent{base: base{TS: r.p.now()}, Items: append([]NMRShield(nil), r.nmrShields...)}) {
			return false
		}
	}
	if r.currentTDState != nil {
		r.excitedStates = append(r.excitedStates, *r.currentTDState)
		r.currentTDState = nil
	}
	if len(r.absSpectrumRows) > 0 || len(r.excitedStates) > 0 {
		merged := mergeExcitedStates(r.absSpectrumRows, r.excitedStates)
		if len(merged) > 0 {
			if !r.emit(ExcitedStatesEvent{base: base{TS: r.p.now()}, Items: merged}) {
				return false
			}
		}
	}
	if r.runEndNormal || r.runEndWallclock > 0 {
		if !r.emit(RunEndEvent{base: base{TS: r.p.now()}, Wallclock: r.runEndWallclock, Normal: r.runEndNormal}) {
			return false
		}
	}
	return true
}

// parseInt and parseFloat wrap strconv with an ok bool so callers can
// skip malformed rows instead of silently using zero values.
func parseInt(s string) (int, bool) {
	v, err := strconv.Atoi(s)
	return v, err == nil
}

func parseFloat(s string) (float64, bool) {
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}
