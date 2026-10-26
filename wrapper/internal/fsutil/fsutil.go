// Package fsutil holds small filesystem helpers shared across packages.
package fsutil

import (
	"fmt"
	"io"
	"os"
)

// CopyFile copies src to dst, truncating dst. Close errors on the
// written file are surfaced — a short write silently dropped here would
// corrupt staged copies of scientific data.
func CopyFile(src, dst string) (retErr error) {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() {
		if cerr := in.Close(); cerr != nil && retErr == nil {
			retErr = cerr
		}
	}()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		if cerr := out.Close(); cerr != nil {
			return fmt.Errorf("%w (and close: %v)", err, cerr)
		}
		return err
	}
	return out.Close()
}
