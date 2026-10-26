package tracker

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/nkls-ai/dftstream/internal/stringutil"
)

// statusUDFFailed is the HTTP status Convex answers with when the function
// itself threw (convex/browser's STATUS_CODE_UDF_FAILED). The backend was
// reached and gave a deterministic answer, so it is never retried as a 5xx.
const statusUDFFailed = 560

// AuthError is a definitive authentication failure: a 401, or a function
// that refused the call as "not authenticated". It unwraps to
// ErrUnauthorized and carries the credential source's own fix line, so a
// command can print that fix instead of a generic "is Convex running?".
type AuthError struct {
	msg string
	// Fix is the actionable fix for the credential source in use.
	Fix string
}

func (e *AuthError) Error() string { return e.msg }

// Unwrap makes errors.Is(err, ErrUnauthorized) hold.
func (e *AuthError) Unwrap() error { return ErrUnauthorized }

// notAuthenticatedRe matches the backend's requireIdentity refusal
// ("Uncaught Error: not authenticated") inside a Convex error message.
var notAuthenticatedRe = regexp.MustCompile(`(?i)\bnot authenticated\b`)

// functionError is the error for a Convex envelope with status "error". A
// "not authenticated" refusal is an AuthError naming the credential fix: an
// auth-on backend answers a caller with no token that way, not with a 401.
func (c *ConvexHTTPTracker) functionError(path, errorMessage string) error {
	if notAuthenticatedRe.MatchString(errorMessage) {
		return &AuthError{
			msg: fmt.Sprintf("Convex function %s refused the call (%v): %s. Fix: %s",
				path, ErrUnauthorized, firstErrorLine(errorMessage), c.src.FixHint()),
			Fix: c.src.FixHint(),
		}
	}
	return fmt.Errorf("Convex function %s failed: %s. Fix: inspect the Convex terminal logs and confirm the db/convex validators match the wrapper payload", path, errorMessage)
}

// udfFailedError decodes the envelope of an HTTP 560 answer.
func (c *ConvexHTTPTracker) udfFailedError(path string, body []byte) error {
	var env convexEnvelope
	if err := json.Unmarshal(body, &env); err != nil || env.ErrorMessage == "" {
		return fmt.Errorf("Convex function %s failed (HTTP %d): %s", path, statusUDFFailed, stringutil.Truncate(body, 200))
	}
	return c.functionError(path, env.ErrorMessage)
}

// firstErrorLine picks the "Uncaught Error: …" line out of a Convex error
// message (which also carries a request id and a stack), else its first line.
func firstErrorLine(msg string) string {
	lines := strings.Split(msg, "\n")
	for _, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "Uncaught") {
			return strings.TrimSpace(l)
		}
	}
	return strings.TrimSpace(lines[0])
}

// withoutFix drops a trailing ". Fix: …" clause from a credential source's
// error. unauthorizedError ends with the source's own fix line, so keeping the
// inner one printed two "Fix:" clauses for one failure.
func withoutFix(err error) string {
	msg := err.Error()
	if i := strings.Index(msg, ". Fix: "); i >= 0 {
		return msg[:i]
	}
	return msg
}
