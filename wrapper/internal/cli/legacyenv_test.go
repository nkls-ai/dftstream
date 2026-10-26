package cli

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
)

func TestLegacyEnvNames(t *testing.T) {
	env := []string{"PATH=/bin", "ORCASTREAM_TOKEN=x", "DFTSTREAM_ORCA=/o", "ORCASTREAM_ORCA=/o"}
	got := LegacyEnvNames(env)
	want := []string{"ORCASTREAM_ORCA", "ORCASTREAM_TOKEN"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("LegacyEnvNames = %v, want %v", got, want)
	}
}

func TestWarnLegacyEnvNamesReplacement(t *testing.T) {
	var buf bytes.Buffer
	WarnLegacyEnv(&buf, []string{"ORCASTREAM_ORCA=/o"})
	if !strings.Contains(buf.String(), "ORCASTREAM_ORCA -> DFTSTREAM_ORCA") {
		t.Fatalf("warning = %q, want the replacement name", buf.String())
	}
	buf.Reset()
	WarnLegacyEnv(&buf, []string{"PATH=/bin"})
	if buf.Len() != 0 {
		t.Fatalf("warning without legacy vars = %q, want nothing", buf.String())
	}
}
