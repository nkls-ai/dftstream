//go:build unix

package auth

import (
	"context"
	"errors"
	"fmt"
	"os"
	"syscall"
	"time"
)

// lockPollInterval is how often a blocked lock attempt retries.
const lockPollInterval = 25 * time.Millisecond

// lockFile takes an exclusive advisory flock on path (created 0600 if
// missing), waiting until ctx is done. It serializes the credentials
// read→refresh→write cycle across every dftstream process sharing the
// file. The returned func releases the lock.
func lockFile(ctx context.Context, path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, credentialsMode)
	if err != nil {
		return nil, fmt.Errorf("open credentials lock: %w", err)
	}
	for {
		err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EINTR) {
			closeLock(f)
			return nil, fmt.Errorf("lock credentials: %w", err)
		}
		select {
		case <-ctx.Done():
			closeLock(f)
			return nil, fmt.Errorf("wait for credentials lock: %w", ctx.Err())
		case <-time.After(lockPollInterval):
		}
	}
	return func() {
		if err := syscall.Flock(int(f.Fd()), syscall.LOCK_UN); err != nil {
			// Closing the descriptor below releases the lock anyway.
			fmt.Fprintf(os.Stderr, "warning: unlock credentials: %v\n", err) //nolint:errcheck — write to stderr is best-effort
		}
		closeLock(f)
	}, nil
}

func closeLock(f *os.File) {
	if err := f.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: close credentials lock: %v\n", err) //nolint:errcheck — write to stderr is best-effort
	}
}
