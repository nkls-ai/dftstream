package artifacts

import (
	"bytes"
	"fmt"
	"io"
	"os"
)

// SpillToDiskBytes is the raw-body size above which the compressed output is
// staged in a temp file instead of memory. Below it the output (~15% of raw)
// is small enough that a buffer is cheaper than a file; above it we refuse to
// grow a second heap allocation that scales with the artifact.
//
// The temp file lives in os.TempDir — never in the chemist's working
// directory, and never near an ORCA-produced file.
const SpillToDiskBytes = 8 << 20 // 8 MiB

// EncodedBody is an artifact body staged for upload.
//
// Reader is seekable so the uploader can replay it on a retry. Close releases
// the staging resources (a temp file, if one was used) and must be called
// exactly once, whether or not the upload succeeded.
type EncodedBody struct {
	Reader   io.ReadSeeker
	Size     int64 // bytes as they will be stored (post-encoding)
	Encoding Encoding
	cleanup  func() error
}

// Close releases the staging resources. Safe to call on a zero-cleanup body.
func (b *EncodedBody) Close() error {
	if b == nil || b.cleanup == nil {
		return nil
	}
	err := b.cleanup()
	b.cleanup = nil
	return err
}

// EncodeBody stages body for upload, compressing it when the artifact's name
// says it is compressible plain text.
//
// The returned *EncodedBody is ALWAYS non-nil and always usable: if
// compression fails for any reason the body falls back to identity encoding
// and the error is returned alongside it as an explanation. Callers must log
// that error and continue — dropping a scientific record because a compressor
// misbehaved is never the right trade.
func EncodeBody(name string, body []byte) (*EncodedBody, error) {
	identity := func() *EncodedBody {
		return &EncodedBody{
			Reader:   bytes.NewReader(body),
			Size:     int64(len(body)),
			Encoding: EncodingIdentity,
		}
	}
	if !Compressible(name) {
		return identity(), nil
	}

	staged, err := stageCompressed(body)
	if err != nil {
		return identity(), fmt.Errorf("compress %q: %w", name, err)
	}
	// A "compressed" body that grew is pure overhead — store it verbatim.
	if staged.Size >= int64(len(body)) {
		if closeErr := staged.Close(); closeErr != nil {
			return identity(), fmt.Errorf("discard oversized compression of %q: %w", name, closeErr)
		}
		return identity(), nil
	}
	return staged, nil
}

// stageCompressed compresses body into memory or, past SpillToDiskBytes, into
// a temp file. Either way the result is seekable and the input is streamed —
// the raw body is read once and never duplicated.
func stageCompressed(body []byte) (*EncodedBody, error) {
	if len(body) < SpillToDiskBytes {
		// Pre-size to a pessimistic 1:4 ratio so the buffer rarely regrows;
		// measured ORCA text lands nearer 1:7.
		buf := bytes.NewBuffer(make([]byte, 0, len(body)/4+512))
		n, err := Compress(buf, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		return &EncodedBody{
			Reader:   bytes.NewReader(buf.Bytes()),
			Size:     n,
			Encoding: EncodingZstd,
		}, nil
	}

	f, err := os.CreateTemp("", "dftstream-artifact-*.zst")
	if err != nil {
		return nil, fmt.Errorf("create staging file: %w", err)
	}
	// Unlink now (POSIX): the open handle keeps the data alive, and the file
	// cannot outlive this process even if we are killed mid-upload. On
	// platforms where this fails, cleanup below removes it by name.
	unlinked := os.Remove(f.Name()) == nil
	cleanup := func() error {
		closeErr := f.Close()
		if unlinked {
			return closeErr
		}
		if rmErr := os.Remove(f.Name()); rmErr != nil && !os.IsNotExist(rmErr) && closeErr == nil {
			return rmErr
		}
		return closeErr
	}

	n, err := Compress(f, bytes.NewReader(body))
	if err != nil {
		if cleanupErr := cleanup(); cleanupErr != nil {
			return nil, fmt.Errorf("%w (and staging cleanup: %v)", err, cleanupErr)
		}
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		if cleanupErr := cleanup(); cleanupErr != nil {
			return nil, fmt.Errorf("rewind staging file: %w (and cleanup: %v)", err, cleanupErr)
		}
		return nil, fmt.Errorf("rewind staging file: %w", err)
	}
	return &EncodedBody{Reader: f, Size: n, Encoding: EncodingZstd, cleanup: cleanup}, nil
}
