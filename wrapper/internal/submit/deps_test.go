package submit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScanDeps(t *testing.T) {
	text := `! r2SCAN-3c OptTS Freq
%maxcore 3000
%geom
    InHess Read
    Hess_Filename "prev.hess"
end
%moinp "guess.gbw"
%neb
    NEB_End_XYZFile end.xyz
    Restart_ALLXYZFile "band_MEP.allxyz"
end
# commented.xyz must not be staged
* xyzfile 0 1 start.xyz
`
	got := ScanDeps(text)
	want := []Dep{
		{"prev.hess", DepHess},
		{"guess.gbw", DepGBW},
		{"end.xyz", DepXYZ},
		{"band_MEP.allxyz", DepAllXYZ},
		{"start.xyz", DepXYZ},
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("dep %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestScanDepsDeduplicates(t *testing.T) {
	got := ScanDeps("* xyzfile 0 1 a.xyz\n%base \"a.xyz\"\n")
	if len(got) != 1 {
		t.Fatalf("got %v, want one entry", got)
	}
}

// The script this replaces matched a `gwb` extension, a typo for `gbw`.
// Recognizing it would stage a file ORCA has never written.
func TestScanDepsIgnoresMisspelledExtension(t *testing.T) {
	if got := ScanDeps("%moinp \"guess.gwb\"\n"); len(got) != 0 {
		t.Fatalf("got %v, want nothing", got)
	}
}

func TestResolveDeps(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "start.xyz"), "1\n\nH 0 0 0\n")

	t.Run("present", func(t *testing.T) {
		got, err := resolveDeps(dir, "job", []Dep{{"start.xyz", DepXYZ}})
		if err != nil || len(got) != 1 {
			t.Fatalf("got %v, %v", got, err)
		}
	})
	t.Run("missing is fatal", func(t *testing.T) {
		_, err := resolveDeps(dir, "job", []Dep{{"gone.xyz", DepXYZ}})
		if err == nil || !strings.Contains(err.Error(), "gone.xyz") {
			t.Fatalf("got %v, want an error naming the file", err)
		}
	})
	t.Run("self-produced is skipped", func(t *testing.T) {
		got, err := resolveDeps(dir, "job", []Dep{{"job.gbw", DepGBW}})
		if err != nil || len(got) != 0 {
			t.Fatalf("got %v, %v; a run's own output must not be demanded up front", got, err)
		}
	})
	t.Run("path components are refused", func(t *testing.T) {
		_, err := resolveDeps(dir, "job", []Dep{{"../shared/start.xyz", DepXYZ}})
		if err == nil || !strings.Contains(err.Error(), "directory path") {
			t.Fatalf("got %v, want a refusal", err)
		}
	})
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
