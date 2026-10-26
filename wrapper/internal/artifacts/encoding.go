package artifacts

import (
	"path/filepath"
	"strings"
)

// Encoding describes how an artifact's *storage blob* is encoded on the
// backend. It is a closed set recorded explicitly on every artifact row we
// write — a reader must never infer it by sniffing the bytes.
//
// The inline preview (Artifact.ContentText) is ALWAYS plain text and is never
// covered by this field: search and the instant preview must not pay a decode.
type Encoding string

const (
	// EncodingIdentity is the body stored verbatim. This is also what an
	// artifact row with no encoding field means — every artifact written
	// before compression existed is identity, and stays readable forever.
	EncodingIdentity Encoding = "identity"
	// EncodingZstd is a single zstd frame (RFC 8878) at ZstdLevel.
	EncodingZstd Encoding = "zstd"
)

// Valid reports whether e is an encoding this build knows how to produce and
// read back.
func (e Encoding) Valid() bool {
	switch e {
	case EncodingIdentity, EncodingZstd:
		return true
	default:
		return false
	}
}

func (e Encoding) String() string { return string(e) }

// ContentType is the HTTP Content-Type to upload a body under.
func (e Encoding) ContentType() string {
	if e == EncodingZstd {
		return "application/zstd"
	}
	return "text/plain"
}

// alreadyCompressedExts are payloads that carry their own compression (or are
// otherwise entropy-dense). Running zstd over them burns CPU for ~0% gain, so
// they stay identity. None of these are collected today — Collect only reads
// bodies for isText names — but the check is explicit so that widening the
// collector later cannot silently start double-compressing.
var alreadyCompressedExts = map[string]bool{
	".gz":   true,
	".tgz":  true,
	".bz2":  true,
	".xz":   true,
	".zst":  true,
	".zstd": true,
	".zip":  true,
	".7z":   true,
	".rar":  true,
	".lz4":  true,
	".png":  true,
	".jpg":  true,
	".jpeg": true,
	".gif":  true,
	".webp": true,
	".pdf":  true,
}

// Compressible reports whether a body for the named artifact should be zstd
// encoded on the way to storage. Only files the collector treats as text are
// compressed: everything else is either binary ORCA scratch (never collected)
// or already compressed.
func Compressible(name string) bool {
	if !isText(name) {
		return false
	}
	ext := strings.ToLower(filepath.Ext(name))
	return !alreadyCompressedExts[ext]
}
