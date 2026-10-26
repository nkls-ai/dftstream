package postproc

import "testing"

const sampleOrbBlock = `ORBITAL ENERGIES
----------------

  NO   OCC          E(Eh)            E(eV)
   0   2.0000     -20.544720      -559.0503
   1   2.0000      -1.308321       -35.6012
   2   2.0000      -0.705563       -19.1993
   3   2.0000      -0.555916       -15.1272
   4   2.0000      -0.495102       -13.4724
   5   0.0000       0.174999         4.7620
   6   0.0000       0.253038         6.8855
*Only the first 10 virtual orbitals were printed.

                    ********************************
`

func TestParseHOMOWater(t *testing.T) {
	homo, ok := ParseHOMOFromOut(sampleOrbBlock)
	if !ok {
		t.Fatalf("expected ok")
	}
	if homo != 4 {
		t.Fatalf("expected HOMO=4, got %d", homo)
	}
}

func TestParseHOMOPicksLast(t *testing.T) {
	// Two blocks — should use the last one.
	text := "ORBITAL ENERGIES\nNO   OCC   E(Eh)   E(eV)\n  0  2.0  -1.0  -27\n  1  0.0   0.1   2.7\n\nlater stuff\n" + sampleOrbBlock
	homo, ok := ParseHOMOFromOut(text)
	if !ok || homo != 4 {
		t.Fatalf("expected HOMO=4, got %d ok=%v", homo, ok)
	}
}

func TestParseHOMOAbsent(t *testing.T) {
	if _, ok := ParseHOMOFromOut("nothing relevant here"); ok {
		t.Fatalf("expected not ok")
	}
}
