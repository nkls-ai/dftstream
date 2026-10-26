package parser

import (
	"math"
)

// captureMECPLine picks state energies off any line while an MECP run is
// active and flushes a complete point. Returns false when the flush's
// emit blocked on a canceled context.
func (r *parseRun) captureMECPLine(line string) bool {
	if v1, v2, ok := parseMECPPair(line); ok {
		r.mecpState1, r.mecpState2 = v1, v2
		r.mecpHave1, r.mecpHave2 = true, true
	} else {
		if v, ok := parseMECPState1(line); ok {
			r.mecpState1, r.mecpHave1 = v, true
		}
		if v, ok := parseMECPState2(line); ok {
			r.mecpState2, r.mecpHave2 = v, true
		}
	}
	return r.flushMECP()
}

func (r *parseRun) flushMECP() bool {
	if !r.mecpActive || !r.mecpHave1 || !r.mecpHave2 || r.mecpEmittedCycle[r.currentCycle] {
		return true
	}
	r.mecpEmittedCycle[r.currentCycle] = true
	return r.emit(MECPPointEvent{
		base:         base{TS: r.p.now()},
		Cycle:        r.currentCycle,
		State1Energy: r.mecpState1,
		State2Energy: r.mecpState2,
		Gap:          math.Abs(r.mecpState2 - r.mecpState1),
	})
}

func (r *parseRun) resetMECPPoint() {
	r.mecpState1, r.mecpState2 = 0, 0
	r.mecpHave1, r.mecpHave2 = false, false
}

func parseMECPPair(line string) (float64, float64, bool) {
	if m := reMECPPair.FindStringSubmatch(line); m != nil {
		v1, ok1 := parseFloat(m[1])
		v2, ok2 := parseFloat(m[2])
		return v1, v2, ok1 && ok2
	}
	return 0, 0, false
}

func parseMECPState1(line string) (float64, bool) {
	if m := reMECPState1.FindStringSubmatch(line); m != nil {
		return parseFloat(m[1])
	}
	return 0, false
}

func parseMECPState2(line string) (float64, bool) {
	if m := reMECPState2.FindStringSubmatch(line); m != nil {
		return parseFloat(m[1])
	}
	return 0, false
}
