package cli

import (
	"fmt"
	"strings"
)

// uiAuthProvider is the login surface `dftstream ui` tells the web app to
// mount (/dftstream-config.json's authProvider). The UI keys its adapter
// registry on exactly these values, so anything else used to reach the
// browser and fail there — or worse, silently mount no auth at all.
type uiAuthProvider string

const (
	uiAuthNone   uiAuthProvider = ""
	uiAuthConvex uiAuthProvider = "convex"
	uiAuthClerk  uiAuthProvider = "clerk"
)

// enabled reports whether the UI should mount an auth gate.
func (p uiAuthProvider) enabled() bool { return p != uiAuthNone }

// parseUIAuthProvider validates --auth-provider / DFTSTREAM_AUTH_PROVIDER
// (case-insensitive, surrounding space ignored) and, for Clerk, that a
// publishable key is present — the UI cannot start without one.
func parseUIAuthProvider(raw, clerkKey string) (uiAuthProvider, error) {
	p := uiAuthProvider(strings.ToLower(strings.TrimSpace(raw)))
	switch p {
	case uiAuthNone, uiAuthConvex:
		return p, nil
	case uiAuthClerk:
		if strings.TrimSpace(clerkKey) == "" {
			return "", fmt.Errorf("--auth-provider clerk needs a publishable key: pass --clerk-publishable-key pk_… or set DFTSTREAM_CLERK_PUBLISHABLE_KEY")
		}
		return p, nil
	default:
		return "", fmt.Errorf("unknown auth provider %q: use %q, %q, or leave it empty for no auth", raw, uiAuthConvex, uiAuthClerk)
	}
}
