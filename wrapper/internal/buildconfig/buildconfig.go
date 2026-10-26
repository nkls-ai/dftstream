// Package buildconfig holds build-time-overridable deployment defaults.
//
// The dev fallback below points at a local Convex backend, so a plain
// `go build` (or `go test`, or running from a checkout) Just Works against a
// developer's local stack with no config. Release builds bake in the
// production URL via -ldflags, exactly like the version stamps:
//
//	-X github.com/nkls-ai/dftstream/internal/buildconfig.DefaultConvexURL=http://your-server:16767
//
// This keeps the production endpoint out of the source tree (devs never have to
// edit it back) while still shipping a binary that targets production by
// default. Users can always override at runtime via -tracker-url /
// --convex-url, the DFTSTREAM_TRACKER_URL / DFTSTREAM_CONVEX_URL env vars, or
// a config-file URL (`dftstream config set-url`).
package buildconfig

// DefaultConvexURL is the Convex backend URL the binary defaults to when no
// runtime override is supplied. Dev fallback is the local backend; release
// builds inject the production URL via ldflags (see package doc).
var DefaultConvexURL = "http://127.0.0.1:3210"
