package tracker

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"syscall"
	"testing"
)

func TestIsUnreachableClassification(t *testing.T) {
	connRefused := &url.Error{Op: "Post", URL: "http://x/api/mutation",
		Err: &url.Error{Op: "dial", URL: "x", Err: syscall.ECONNREFUSED}}
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"connection refused via url.Error", fmt.Errorf("request failed after 9 attempt(s): %w", connRefused), true},
		{"bare ECONNREFUSED", syscall.ECONNREFUSED, true},
		{"client deadline", fmt.Errorf("flush: %w", context.DeadlineExceeded), true},
		{"caller cancelled", fmt.Errorf("flush: %w", context.Canceled), false},
		{"cancelled inside transport", &url.Error{Op: "Post", URL: "x", Err: context.Canceled}, false},
		{"auth rejected", fmt.Errorf("HTTP 401 (%w): no", ErrUnauthorized), false},
		{"server-side failure", errors.New("Convex function x returned HTTP 500: boom"), false},
		{"validator failure", errors.New("Convex function x failed: ArgumentValidationError"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsUnreachable(tc.err); got != tc.want {
				t.Fatalf("IsUnreachable(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
