package cli

import (
	"errors"

	"github.com/nkls-ai/dftstream/internal/auth"
	"github.com/nkls-ai/dftstream/internal/tracker"
)

// resolveAuth returns the org to target plus the credential source for the
// backend at convexURL. The selection (DFTSTREAM_TOKEN > stored login >
// none) and the org precedence (--org > DFTSTREAM_ORG > the source's own)
// live in auth.Resolve — the only place a credential source is picked.
func resolveAuth(convexURL, orgFlag string) (string, auth.TokenSource, error) {
	session, err := auth.Resolve(convexURL, orgFlag)
	if err != nil {
		return "", nil, err
	}
	return session.Org, session.Source, nil
}

// authFixHint is the shared "fix" line commands print when resolveAuth fails.
func authFixHint() string { return auth.ResolveFixHint() }

// backendFixHint is the fix line for a failed backend call, shared by every
// command that talks to the backend. An authentication failure gets the fix
// for the credential actually in use (log in, or DFTSTREAM_TOKEN for batch
// jobs) instead of the command's generic fallback ("is Convex running?").
func backendFixHint(err error, fallback string) string {
	var authErr *tracker.AuthError
	switch {
	case errors.As(err, &authErr):
		return authErr.Fix
	case errors.Is(err, tracker.ErrUnauthorized):
		return authFixHint()
	case errors.Is(err, tracker.ErrOrgNotAvailable):
		return "Drop --org / DFTSTREAM_ORG, or use a credential for that organization."
	default:
		return fallback
	}
}
