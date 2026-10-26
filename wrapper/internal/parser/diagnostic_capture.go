package parser

// classifyDiagnostic reports whether the line diagnoses a failure and, if
// so, opens the excerpt capture for it. Used as a boolean case in the
// landmark switch, so an emit that blocks on a canceled context is
// recorded in landmarkAborted rather than returned.
func (r *parseRun) classifyDiagnostic(upperLine, line string) bool {
	class, ok := classifyLine(upperLine)
	if !ok {
		return false
	}
	if !r.startDiagnostic(class, line) {
		r.landmarkAborted = true
	}
	return true
}

// startDiagnostic opens an excerpt capture for class around line. Only
// the first occurrence of a class is reported: ORCA repeats "not enough
// memory" once per pair, and one event per class is what a consumer
// needs. Returns false when flushing a previous capture blocked on a
// canceled context.
func (r *parseRun) startDiagnostic(class ErrorClass, line string) bool {
	if r.diagSeen[class] {
		return true
	}
	r.diagSeen[class] = true
	// A second diagnosis before the first capture filled up: close the
	// first with what it has rather than interleave the two.
	if !r.flushDiagnostic() {
		return false
	}
	lines := make([]string, 0, len(r.recent)+1+excerptLinesAfter)
	lines = append(lines, r.recent...)
	lines = append(lines, line)
	r.diagPending = &diagnosticCapture{class: class, lines: lines, remain: excerptLinesAfter}
	return true
}

// absorbDiagnostic feeds one line into an open capture's trailing
// context, emitting the event once the capture is full.
func (r *parseRun) absorbDiagnostic(line string) bool {
	if r.diagPending == nil || r.diagPending.remain == 0 {
		return true
	}
	r.diagPending.lines = append(r.diagPending.lines, line)
	r.diagPending.remain--
	if r.diagPending.remain > 0 {
		return true
	}
	return r.flushDiagnostic()
}

// flushDiagnostic emits the open capture, if any.
func (r *parseRun) flushDiagnostic() bool {
	if r.diagPending == nil {
		return true
	}
	pending := r.diagPending
	r.diagPending = nil
	return r.emit(DiagnosticEvent{
		base:    base{TS: r.p.now()},
		Class:   pending.class,
		Excerpt: buildExcerpt(pending.lines),
	})
}

// pushRecent appends line to the ring of leading-context lines.
func (r *parseRun) pushRecent(line string) {
	if excerptLinesBefore == 0 {
		return
	}
	if len(r.recent) == excerptLinesBefore {
		copy(r.recent, r.recent[1:])
		r.recent = r.recent[:excerptLinesBefore-1]
	}
	r.recent = append(r.recent, line)
}
