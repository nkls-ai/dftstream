package tracker

import (
	"context"
	"errors"
	"net"
	"net/url"
	"syscall"
)

// ErrUnauthorized marks a definitive HTTP 401 from the backend. It is a
// distinct class from "unreachable": an auth failure must surface loudly
// (the fix is `dftstream login`), never be treated as a network outage
// that spool mode may quietly absorb.
var ErrUnauthorized = errors.New("unauthorized")

// IsUnreachable reports whether err means the backend could not be
// reached at all — connection refused, no route, DNS failure, or a
// request/handshake timeout. This is the class of failure spool mode
// exists for (a firewalled compute node), so it is deliberately strict:
//
//   - auth failures (ErrUnauthorized) are NOT unreachable — the network
//     worked and the operator must be told to re-login;
//   - an HTTP error status (4xx/5xx) is NOT unreachable — the backend
//     answered, so journaling would just hide a real server-side problem;
//   - context.Canceled is NOT unreachable — the *caller* gave up
//     (^C mid-run), and failing over during shutdown would journal a tail
//     of a run that was otherwise live-tracked for no benefit.
func IsUnreachable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrUnauthorized) || errors.Is(err, context.Canceled) {
		return false
	}
	// Client-side deadline: the backend never answered inside the budget.
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	// Transport-level failure from net/http (dial, DNS, TLS, timeout).
	// url.Error is only produced when no HTTP response was received.
	var uerr *url.Error
	if errors.As(err, &uerr) {
		return true
	}
	var nerr net.Error
	if errors.As(err, &nerr) {
		return true
	}
	return errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.EHOSTUNREACH) ||
		errors.Is(err, syscall.ENETUNREACH)
}
