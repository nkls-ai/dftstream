// Package version exposes build-time identification stamps.
//
// Release builds (goreleaser, the CI Release workflow) override the
// defaults via -ldflags so users can pin a bug report to an exact
// commit + build date:
//
//	-X github.com/nkls-ai/dftstream/internal/version.Version=v1.2.3
//	-X github.com/nkls-ai/dftstream/internal/version.Commit=<sha>
//	-X github.com/nkls-ai/dftstream/internal/version.Date=<RFC3339>
//
// Local `go build` keeps the dev fallback so the binary still runs and
// reports something useful.
package version

import (
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
)

var (
	// Version is the semantic-version tag (e.g. "v1.2.3") for tagged
	// releases, or "dev" for local builds.
	Version = "dev"
	// Commit is the short git SHA the binary was built from, or
	// "unknown" if it could not be determined.
	Commit = ""
	// Date is the build timestamp (RFC3339), or empty if unset.
	Date = ""
)

// APIVersion is the wrapper's half of the backend contract — the version
// of the Convex function surface (function names, argument shapes) this
// binary expects. It is deliberately NOT Version: the product version
// moves on every release, while the API version only moves when an older
// wrapper can no longer talk to a newer backend (or vice versa).
//
// It must stay in lockstep with API_VERSION in db/convex/meta.ts. The
// backend at API version N serves wrappers at N and N-1; see
// cli.checkBackendVersion for how the two are compared at startup.
const APIVersion = 1

// UserAgent is the value sent as the HTTP User-Agent header on every
// backend call, so an operator reading Convex access logs can tell which
// wrapper build produced a request (and spot stragglers after an upgrade)
// without correlating by hand.
//
// Shape: "dftstream/<version> (api <n>; <goos>/<goarch>)".
func UserAgent() string {
	return "dftstream/" + Version +
		" (api " + strconv.Itoa(APIVersion) + "; " + runtime.GOOS + "/" + runtime.GOARCH + ")"
}

// String renders a single-line summary suitable for the `--version`
// output. Falls back to runtime/debug.BuildInfo when ldflags weren't
// injected (i.e. plain `go build` from a working tree).
func String() string {
	v := Version
	commit := Commit
	date := Date
	if commit == "" || date == "" {
		if info, ok := debug.ReadBuildInfo(); ok {
			for _, s := range info.Settings {
				switch s.Key {
				case "vcs.revision":
					if commit == "" {
						commit = shortSHA(s.Value)
					}
				case "vcs.time":
					if date == "" {
						date = s.Value
					}
				case "vcs.modified":
					if s.Value == "true" && !strings.HasSuffix(commit, "-dirty") {
						commit += "-dirty"
					}
				}
			}
		}
	}
	if commit == "" {
		commit = "unknown"
	}
	if date == "" {
		date = "unknown"
	}
	return v + " (commit " + commit + ", built " + date + ")"
}

func shortSHA(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
