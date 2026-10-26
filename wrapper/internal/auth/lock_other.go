//go:build !unix

package auth

import "context"

// lockFile is a no-op where flock is unavailable (Windows). Refreshes are
// still serialized within one process; across processes the backend's
// rotation grace window is the only protection.
func lockFile(context.Context, string) (func(), error) {
	return func() {}, nil
}
