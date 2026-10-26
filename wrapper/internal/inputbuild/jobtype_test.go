package inputbuild

import (
	"strings"
	"testing"
)

func TestJobKeywords(t *testing.T) {
	cases := []struct {
		job  JobType
		want string
	}{
		{JobSP, ""},
		{JobOpt, "Opt"},
		{JobOptFreq, "Opt Freq"},
		{JobFreq, "Freq"},
		{JobOptTS, "OptTS"},
		{JobOptTSFreq, "OptTS Freq"},
		{JobNEBTSFreq, "NEB-TS Freq"},
		{JobIRC, "IRC"},
		{JobGoatEntropy, "GOAT-Entropy"},
		{JobScan, "Opt"},
		{JobTDDFT, ""},
		{JobNMR, "NMR"},
		{JobMECP, "MECP"},
	}
	for _, tc := range cases {
		if got := strings.Join(tc.job.Keywords(), " "); got != tc.want {
			t.Errorf("%s keywords = %q, want %q", tc.job, got, tc.want)
		}
	}
}

func TestJobKeywordsAreNotAliased(t *testing.T) {
	// Keywords() must hand out a copy: a caller appending to it would
	// otherwise corrupt every later job of the same type.
	first := append(JobOptFreq.Keywords(), "TightSCF")
	if got := strings.Join(JobOptFreq.Keywords(), " "); got != "Opt Freq" {
		t.Fatalf("table mutated to %q via %v", got, first)
	}
}

func TestParseJobType(t *testing.T) {
	if j, ok := ParseJobType(" Opt-Freq "); !ok || j != JobOptFreq {
		t.Errorf("ParseJobType = %q, %v", j, ok)
	}
	if _, ok := ParseJobType("optfreq"); ok {
		t.Error("unknown job type must be rejected, not silently defaulted")
	}
}

func TestNeedsFrequencies(t *testing.T) {
	for job, want := range map[JobType]bool{
		JobOptFreq: true, JobOptTSFreq: true, JobNEBTSFreq: true,
		JobOpt: false, JobSP: false, JobIRC: false,
	} {
		if got := job.NeedsFrequencies(); got != want {
			t.Errorf("%s NeedsFrequencies = %v, want %v", job, got, want)
		}
	}
}

func TestKeywordsForStripsParentRunKeywords(t *testing.T) {
	parent := []string{"wB97X-D3", "def2-TZVP", "TightOpt", "Freq", "CPCM(water)"}
	got := strings.Join(KeywordsFor(parent, JobIRC), " ")
	want := "wB97X-D3 def2-TZVP CPCM(water) IRC"
	if got != want {
		t.Errorf("keywords = %q, want %q", got, want)
	}
	// The NEB drivers and IRC itself are run keywords too.
	got = strings.Join(KeywordsFor([]string{"XTB", "NEB-TS", "Freq", "IRC"}, JobOptFreq), " ")
	if got != "XTB Opt Freq" {
		t.Errorf("keywords = %q, want %q", got, "XTB Opt Freq")
	}
	// So are the property/crossing drivers: a parent NMR or MECP token
	// must not leak into a follow-up optimization.
	got = strings.Join(KeywordsFor([]string{"wB97X-D4", "def2-TZVP", "NMR"}, JobOpt), " ")
	if got != "wB97X-D4 def2-TZVP Opt" {
		t.Errorf("keywords = %q, want %q", got, "wB97X-D4 def2-TZVP Opt")
	}
	got = strings.Join(KeywordsFor([]string{"UKS", "B3LYP", "def2-SVP", "MECP"}, JobFreq), " ")
	if got != "UKS B3LYP def2-SVP Freq" {
		t.Errorf("keywords = %q, want %q", got, "UKS B3LYP def2-SVP Freq")
	}
}

func TestKeywordsForDoesNotMutateParent(t *testing.T) {
	parent := []string{"XTB", "Opt", "Freq"}
	KeywordsFor(parent, JobIRC)
	if strings.Join(parent, " ") != "XTB Opt Freq" {
		t.Errorf("parent keywords mutated: %v", parent)
	}
}

func TestMergeKeyword(t *testing.T) {
	kws := []string{"B3LYP", "def2-SVP"}
	kws = MergeKeyword(kws, "tightscf")
	kws = MergeKeyword(kws, "TightSCF") // already present, case-insensitively
	kws = MergeKeyword(kws, "")
	if got := strings.Join(kws, " "); got != "B3LYP def2-SVP tightscf" {
		t.Errorf("merged = %q", got)
	}
}

func TestMaxCoreMB(t *testing.T) {
	cases := []struct {
		ramMB, procs, want int
	}{
		{64 * 1024, 8, 6000}, // round(64*0.75/8) = 6 GB
		{16 * 1024, 4, 3000}, // round(16*0.75/4) = 3 GB
		{8 * 1024, 16, 0},    // below 1 GB/core → leave %maxcore out
		{0, 8, 0},            // unknown RAM
		{64 * 1024, 0, 0},    // unknown core count
		{128 * 1024, 32, 3000},
	}
	for _, tc := range cases {
		if got := MaxCoreMB(tc.ramMB, tc.procs); got != tc.want {
			t.Errorf("MaxCoreMB(%d, %d) = %d, want %d", tc.ramMB, tc.procs, got, tc.want)
		}
	}
}
