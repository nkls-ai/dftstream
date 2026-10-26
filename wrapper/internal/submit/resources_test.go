package submit

import (
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/inputlint"
)

// realInput is one of the inputs this command was written for: an
// r2SCAN-3c opt+freq on 8 cores with 3000 MB per core.
const realInput = `! r2SCAN-3c TightOpt Freq CPCM(DMSO)

%maxcore 3000

%pal
    nprocs 8
end

* xyzfile 0 2 ma1-tbu.xyz
`

func TestResourcesForRealInput(t *testing.T) {
	res, err := ResourcesFor(realInput)
	if err != nil {
		t.Fatalf("ResourcesFor: %v", err)
	}
	if res.Threads != 8 || res.MaxCoreMB != 3000 {
		t.Fatalf("got %+v, want 8 threads / 3000 MB maxcore", res)
	}
	// The script this replaces asks for 32 (GB) here; matching that
	// number is the point of the exercise.
	if res.MemoryGB != 32 {
		t.Errorf("MemoryGB = %d, want 32", res.MemoryGB)
	}
}

// TestMemoryClearsTheLinter is the property that matters: the memory we
// reserve is enough that inputlint would not warn about this input on
// such a node, and one gigabyte less would not be.
func TestMemoryClearsTheLinter(t *testing.T) {
	for _, text := range []string{realInput, palInput(4, 2000), palInput(16, 8000), palInput(1, 500)} {
		res, err := ResourcesFor(text)
		if err != nil {
			t.Fatalf("ResourcesFor: %v", err)
		}
		if flagged(text, res.MemoryGB*1000) {
			t.Errorf("%d GB still trips %s for %q", res.MemoryGB, maxcoreRAMFinding, oneLine(text))
		}
		if !flagged(text, res.Threads*res.MaxCoreMB) {
			t.Errorf("sanity: a node with exactly the requested %d MB should trip the check", res.Threads*res.MaxCoreMB)
		}
	}
}

func TestResourcesForRequiresBoth(t *testing.T) {
	for name, text := range map[string]string{
		"no maxcore": "! r2SCAN-3c Opt\n%pal nprocs 8 end\n",
		"no nprocs":  "! r2SCAN-3c Opt\n%maxcore 3000\n",
		"neither":    "! r2SCAN-3c Opt\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ResourcesFor(text); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestResourcesRejectsAbsurdRequest(t *testing.T) {
	huge := "! r2SCAN-3c Opt\n%maxcore 99999999999999999999\n%pal nprocs 8 end\n"
	if _, err := ResourcesFor(huge); err == nil {
		t.Fatal("expected an error for an overflowing %maxcore")
	}
}

func palInput(nprocs, maxcore int) string {
	return "! r2SCAN-3c Opt\n" +
		"%maxcore " + itoa(maxcore) + "\n" +
		"%pal nprocs " + itoa(nprocs) + " end\n"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func flagged(text string, ramMB int) bool {
	for _, f := range inputlint.Lint(text, inputlint.Options{TotalRAMMB: ramMB}) {
		if f.Code == maxcoreRAMFinding {
			return true
		}
	}
	return false
}

func oneLine(s string) string { return strings.ReplaceAll(strings.TrimSpace(s), "\n", " ") }
