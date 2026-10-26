package artifacts

import (
	"fmt"
	"io"

	"github.com/klauspost/compress/zstd"
)

// ZstdLevel is the zstd compression level artifact bodies are stored at,
// expressed on zstd's own 1..22 scale. Level 9 was chosen by measuring a real
// ORCA corpus: it lands around 15% of raw at tens of MB/s, where level 19 buys
// only a few more points at ~20x the CPU cost.
const ZstdLevel = 9

// zstdWindowBytes bounds the encoder's match window. ORCA output is extremely
// self-similar over short spans (repeated SCF iteration tables), so a 1 MiB
// window captures nearly all of the redundancy while keeping the encoder's
// per-stream allocation small — we may encode a few dozen artifacts per run.
const zstdWindowBytes = 1 << 20

func encoderOptions() []zstd.EOption {
	return []zstd.EOption{
		zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(ZstdLevel)),
		// One goroutine per stream: bodies are compressed one at a time and
		// the default (GOMAXPROCS) would reserve a window buffer per core.
		zstd.WithEncoderConcurrency(1),
		zstd.WithWindowSize(zstdWindowBytes),
	}
}

// countingWriter tracks how many bytes reached the underlying writer, so a
// streaming compressor can report its output size without buffering it.
type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

// Compress streams src through zstd into dst and returns the number of
// compressed bytes written. Nothing is buffered beyond the encoder's window,
// so a 100 MB body never exists twice in memory.
func Compress(dst io.Writer, src io.Reader) (int64, error) {
	cw := &countingWriter{w: dst}
	enc, err := zstd.NewWriter(cw, encoderOptions()...)
	if err != nil {
		return 0, fmt.Errorf("zstd: new encoder: %w", err)
	}
	if _, err := io.Copy(enc, src); err != nil {
		// Close releases the encoder's goroutine/buffers. Its error is
		// irrelevant here — the copy failure is the one worth reporting.
		if closeErr := enc.Close(); closeErr != nil {
			return 0, fmt.Errorf("zstd: compress: %w (and close: %v)", err, closeErr)
		}
		return 0, fmt.Errorf("zstd: compress: %w", err)
	}
	// Close flushes the final block and writes the frame epilogue; skipping
	// it would produce a truncated frame no decoder can read.
	if err := enc.Close(); err != nil {
		return 0, fmt.Errorf("zstd: finish frame: %w", err)
	}
	return cw.n, nil
}

// Decompress streams a zstd frame from src into dst and returns the number of
// decoded bytes. Used by the round-trip tests and by any Go-side reader of an
// encoded blob.
func Decompress(dst io.Writer, src io.Reader) (int64, error) {
	dec, err := zstd.NewReader(src, zstd.WithDecoderConcurrency(1))
	if err != nil {
		return 0, fmt.Errorf("zstd: new decoder: %w", err)
	}
	defer dec.Close() // Close has no error to return; it only frees goroutines.
	n, err := io.Copy(dst, dec.IOReadCloser())
	if err != nil {
		return n, fmt.Errorf("zstd: decompress: %w", err)
	}
	return n, nil
}
