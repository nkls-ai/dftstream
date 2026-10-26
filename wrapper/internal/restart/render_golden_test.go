package restart

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nkls-ai/dftstream/internal/inputparse"
)

// Golden test for the input renderer. Restart inputs go straight to a
// cluster queue, so the exact bytes are the contract: the move onto the
// typed inputbuild model must not change a single character.
//
//	DFTSTREAM_UPDATE_GOLDEN=1 go test ./internal/restart/

var goldenGeom = []Atom{
	{El: "C", X: 0, Y: 0, Z: 0},
	{El: "N", X: -0.5, Y: 1.25, Z: 1.16},
	{El: "H", X: 0, Y: 0, Z: -1.07},
}

type renderCase struct {
	name  string
	input string // the parent .inp text, parsed for the Summary
	kws   []string
	blks  []string
	// xyzFile non-empty renders the BuildInputXYZFile variant.
	xyzFile string
}

func renderCases() []renderCase {
	return []renderCase{
		{
			name:  "inline-no-resources",
			input: "! XTB Opt Freq\n* xyz 0 1\nC 0 0 0\n*\n",
			kws:   []string{"XTB", "Opt", "Freq"},
		},
		{
			name:  "inline-pal-and-maxcore",
			input: "! r2SCAN-3c Opt Freq\n%pal nprocs 8 end\n%maxcore 3000\n* xyz -2 3\nC 0 0 0\n*\n",
			kws:   []string{"r2SCAN-3c", "Opt", "Freq"},
		},
		{
			name:  "inline-with-blocks",
			input: "! wB97X-D4 def2-TZVP OptTS Freq\n%pal nprocs 4 end\n* xyz 1 2\nC 0 0 0\n*\n",
			kws:   []string{"wB97X-D4", "def2-TZVP", "OptTS", "Freq"},
			blks:  []string{"%geom\n  Calc_Hess true\nend", "%scf\n  MaxIter 300\nend\n"},
		},
		{
			name:    "xyzfile-with-neb-block",
			input:   "! XTB NEB-TS Freq\n%pal nprocs 16 end\n%maxcore 2000\n* xyz 0 1\nC 0 0 0\n*\n",
			kws:     []string{"XTB", "NEB-TS", "Freq"},
			blks:    []string{"%neb\n  NEB_End_XYZFile \"p.xyz\"\n  Nimages 8\nend"},
			xyzFile: "r.xyz",
		},
		{
			name:    "xyzfile-no-blocks",
			input:   "! B97-3c Opt\n* xyz 0 1\nC 0 0 0\n*\n",
			kws:     []string{"B97-3c", "Opt"},
			xyzFile: "start.xyz",
		},
	}
}

func TestBuildInputIsByteIdentical(t *testing.T) {
	update := os.Getenv("DFTSTREAM_UPDATE_GOLDEN") != ""
	goldenDir := filepath.Join("testdata", "golden")
	if update {
		if err := os.MkdirAll(goldenDir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range renderCases() {
		t.Run(tc.name, func(t *testing.T) {
			summary := inputparse.Parse(tc.input)
			var got string
			if tc.xyzFile != "" {
				got = BuildInputXYZFile(summary, tc.kws, tc.xyzFile, tc.blks...)
			} else {
				got = BuildInput(summary, tc.kws, goldenGeom, tc.blks...)
			}
			path := filepath.Join(goldenDir, tc.name+".inp")
			if update {
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("missing golden (run with DFTSTREAM_UPDATE_GOLDEN=1): %v", err)
			}
			if got != string(want) {
				t.Errorf("rendered bytes changed.\n--- want ---\n%s\n--- got ---\n%s",
					strings.ReplaceAll(string(want), " ", "·"), strings.ReplaceAll(got, " ", "·"))
			}
		})
	}
}
