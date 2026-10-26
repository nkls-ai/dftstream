package inputparse

import "testing"

func TestProvenanceRoundTrip(t *testing.T) {
	p := Provenance{Edge: "neb-ts", ParentExp: "Sn2", ParentRun: "react_opt"}
	text := p.Comment() + "! XTB NEB-TS\n* xyz 0 1\nH 0 0 0\n*\n"
	got, ok := ParseProvenance(text)
	if !ok || got != p {
		t.Fatalf("ParseProvenance = %+v ok=%v, want %+v", got, ok, p)
	}
	// The comment is inert to keyword parsing.
	s := Parse(text)
	if len(s.RunTypes) != 1 || s.RunTypes[0] != RunTypeNEBTS {
		t.Errorf("RunTypes = %v, want [NEB-TS]", s.RunTypes)
	}
	legacy := "# orcastream: edge=irc parent=\"Sn2/ts\"\n! IRC\n"
	if got, ok := ParseProvenance(legacy); !ok || got != (Provenance{Edge: "irc", ParentExp: "Sn2", ParentRun: "ts"}) {
		t.Errorf("legacy marker: ParseProvenance = %+v ok=%v", got, ok)
	}
	if _, ok := ParseProvenance("! Opt\n"); ok {
		t.Error("ParseProvenance must not match plain inputs")
	}
}
