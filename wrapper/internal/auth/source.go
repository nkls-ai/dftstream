// Package auth is the wrapper's credential layer. Every way the CLI can
// authenticate to the backend is a TokenSource; the tracker only ever sees
// that interface. Resolve (resolve.go) is the single place that picks one.
//
// Adding a credential source: implement TokenSource in a new file here, give
// it a Kind, and add its branch to Resolve in the precedence order.
package auth

import (
	"context"
	"errors"
)

// Kind names a credential source. Typed so selection never compares strings.
type Kind int

const (
	// KindNone sends no bearer token (auth-off / not logged in).
	KindNone Kind = iota
	// KindStoredLogin uses credentials.json written by `dftstream login`.
	KindStoredLogin
	// KindMachineToken exchanges DFTSTREAM_TOKEN for access tokens.
	KindMachineToken
)

func (k Kind) String() string {
	switch k {
	case KindNone:
		return "none"
	case KindStoredLogin:
		return "stored-login"
	case KindMachineToken:
		return "machine-token"
	default:
		return "unknown"
	}
}

// ErrNoRefresh is returned by Invalidate when a source cannot mint a
// replacement token (KindNone).
var ErrNoRefresh = errors.New("no credentials to refresh")

// TokenSource supplies bearer tokens for backend requests.
type TokenSource interface {
	// Token returns the bearer token to send; "" means send none.
	Token(ctx context.Context) (string, error)
	// Invalidate reports that `rejected` was answered with HTTP 401 and
	// returns a replacement. Concurrent callers that saw the same rejected
	// token share one refresh: if the source already moved past `rejected`,
	// the current token is returned without another round trip.
	Invalidate(ctx context.Context, rejected string) (string, error)
	// FixHint is the actionable fix for a definitive 401 with this source.
	FixHint() string
	// Kind identifies the source.
	Kind() Kind
}

// Session is the resolved credential source plus the organization to target.
type Session struct {
	Org    string
	Source TokenSource
}

// loginFixHint is the 401 fix for anything but a machine token. Wording is
// the tracker's historical message, kept byte-identical.
const loginFixHint = "run `dftstream login` to (re)authenticate"

// notLoggedInFixHint is the fix when no credential was sent at all: log in,
// or — for a batch job that cannot open a browser — use a machine token.
const notLoggedInFixHint = "run `dftstream login` to authenticate, or set " + EnvMachineToken + " to a machine token for batch jobs"

// None is the unauthenticated source: no header, nothing to refresh.
type None struct{}

// Token returns "" — no Authorization header is sent.
func (None) Token(context.Context) (string, error) { return "", nil }

// Invalidate always fails: there is nothing to refresh.
func (None) Invalidate(context.Context, string) (string, error) { return "", ErrNoRefresh }

// FixHint tells the user to log in (or use a machine token).
func (None) FixHint() string { return notLoggedInFixHint }

// Kind is KindNone.
func (None) Kind() Kind { return KindNone }
