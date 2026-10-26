package inputparse

import "testing"

func TestRunTypePredicates(t *testing.T) {
	cases := []struct {
		rt       RunType
		isOpt    bool
		isTS     bool
		geometry bool
	}{
		{RunTypeOpt, true, false, true},
		{RunTypeCOpt, true, false, true},
		{RunTypeOptTS, true, true, true},
		{RunTypeNEBTS, true, true, true},
		{RunTypeZoomNEBTS, true, true, true},
		{RunTypeNEB, false, false, true},
		{RunTypeNEBCI, false, false, true},
		{RunTypeZoomNEBCI, false, false, true},
		{RunTypeNEBIDPP, false, false, true},
		{RunTypeGoat, false, false, true},
		{RunTypeIRC, false, false, true},
		{RunTypeScan, false, false, true},
		{RunTypeScanTS, false, false, true},
		{RunTypeSP, false, false, false},
		{RunTypeFreq, false, false, false},
	}
	for _, c := range cases {
		if got := c.rt.IsOptimization(); got != c.isOpt {
			t.Errorf("%s.IsOptimization() = %v, want %v", c.rt, got, c.isOpt)
		}
		if got := c.rt.IsTransitionStateSearch(); got != c.isTS {
			t.Errorf("%s.IsTransitionStateSearch() = %v, want %v", c.rt, got, c.isTS)
		}
		if got := c.rt.DrivesGeometry(); got != c.geometry {
			t.Errorf("%s.DrivesGeometry() = %v, want %v", c.rt, got, c.geometry)
		}
	}
}

func TestJobTypeIsGeometryOpt(t *testing.T) {
	for _, j := range []JobType{JobTypeOpt, JobTypeOptFreq, JobTypeOptTS, JobTypeOptTSFreq} {
		if !j.IsGeometryOpt() {
			t.Errorf("%s.IsGeometryOpt() = false, want true", j)
		}
	}
	for _, j := range []JobType{JobTypeFreq, JobType("GOAT"), JobType("SCAN"), JobType("")} {
		if j.IsGeometryOpt() {
			t.Errorf("%s.IsGeometryOpt() = true, want false", j)
		}
	}
}

func TestSummaryRequestsOptimization(t *testing.T) {
	if !Parse("! OPTTS Freq\n").RequestsOptimization() {
		t.Error("OPTTS input should request optimization")
	}
	if !Parse("! OPTTS Freq\n").RequestsTransitionState() {
		t.Error("OPTTS input should request a transition state")
	}
	if Parse("! HF SP\n").RequestsOptimization() {
		t.Error("SP input should not request optimization")
	}
	// COPT counts as an optimization but not a TS search.
	s := Parse("! COPT\n")
	if !s.RequestsOptimization() || s.RequestsTransitionState() {
		t.Errorf("COPT: RequestsOptimization=%v RequestsTransitionState=%v, want true/false",
			s.RequestsOptimization(), s.RequestsTransitionState())
	}
}

func TestOptFreqKeywordPredicates(t *testing.T) {
	for _, tok := range []string{"Opt", "COPT", "OptTS", "TightOpt", "VeryTightOpt", "LooseOpt", "NormalOpt"} {
		if !IsOptKeyword(tok) {
			t.Errorf("IsOptKeyword(%q) = false, want true", tok)
		}
	}
	for _, tok := range []string{"Freq", "B3LYP", "GOAT", "SP"} {
		if IsOptKeyword(tok) {
			t.Errorf("IsOptKeyword(%q) = true, want false", tok)
		}
	}
	for _, tok := range []string{"Freq", "NumFreq", "AnFreq"} {
		if !IsFreqKeyword(tok) {
			t.Errorf("IsFreqKeyword(%q) = false, want true", tok)
		}
	}
	if IsFreqKeyword("Opt") {
		t.Error("IsFreqKeyword(Opt) = true, want false")
	}
}

func TestRunTypeIsNEBBand(t *testing.T) {
	band := []RunType{RunTypeNEB, RunTypeNEBCI, RunTypeNEBTS, RunTypeZoomNEB, RunTypeZoomNEBCI, RunTypeZoomNEBTS}
	for _, rt := range band {
		if !rt.IsNEBBand() {
			t.Errorf("%s.IsNEBBand() = false, want true", rt)
		}
	}
	for _, rt := range []RunType{RunTypeNEBIDPP, RunTypeOpt, RunTypeOptTS, RunTypeIRC, RunTypeSP} {
		if rt.IsNEBBand() {
			t.Errorf("%s.IsNEBBand() = true, want false", rt)
		}
	}
}
