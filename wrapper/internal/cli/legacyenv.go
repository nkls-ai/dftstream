package cli

import (
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/nkls-ai/dftstream/internal/cliui"
)

// legacyEnvPrefix is the variable prefix used before the project was renamed
// from OrcaStream. Those variables are no longer read.
const legacyEnvPrefix = "ORCASTREAM_"

// LegacyEnvNames returns the ORCASTREAM_* variables set in environ, sorted.
func LegacyEnvNames(environ []string) []string {
	var names []string
	for _, kv := range environ {
		name, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(name, legacyEnvPrefix) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// WarnLegacyEnv prints one warning when pre-rename variables are set, naming
// their replacements, so a renamed setting is never lost without notice.
func WarnLegacyEnv(w io.Writer, environ []string) {
	names := LegacyEnvNames(environ)
	if len(names) == 0 {
		return
	}
	renames := make([]string, len(names))
	for i, name := range names {
		renames[i] = fmt.Sprintf("%s -> DFTSTREAM_%s", name, strings.TrimPrefix(name, legacyEnvPrefix))
	}
	cliui.Warning(w,
		"ignoring variables from before the rename to DFTStream: "+strings.Join(names, ", "),
		"rename them in your shell profile or job script: "+strings.Join(renames, "; "))
}
