package fsutil

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// LoadJSON decodes the JSON file at path into T. A missing file (or
// empty path) returns the zero value with no error, so unconfigured
// local flows keep working.
func LoadJSON[T any](path string) (T, error) {
	var v T
	if path == "" {
		return v, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return v, nil
		}
		return v, err
	}
	if err := json.Unmarshal(data, &v); err != nil {
		var zero T
		return zero, err
	}
	return v, nil
}

// SaveJSONAtomic writes v as indented JSON (with trailing newline) to path at
// the given mode, creating parent directories as needed. The write is atomic
// (temp file in the same directory, then rename): credentials.json carries a
// rotating refresh token, and a torn write there would strand every process
// sharing the file with an unusable half-token.
func SaveJSONAtomic(path string, v any, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	removeTemp := func() {
		if rmErr := os.Remove(tmpName); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
			fmt.Fprintf(os.Stderr, "warning: could not remove temp file %s: %v\n", tmpName, rmErr)
		}
	}
	// CreateTemp makes the file 0600; widen/narrow to the requested mode
	// before any bytes land so secrets are never world-readable, even briefly.
	if err := tmp.Chmod(mode); err != nil {
		if closeErr := tmp.Close(); closeErr != nil {
			fmt.Fprintf(os.Stderr, "warning: closing temp file: %v\n", closeErr)
		}
		removeTemp()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		if closeErr := tmp.Close(); closeErr != nil {
			fmt.Fprintf(os.Stderr, "warning: closing temp file: %v\n", closeErr)
		}
		removeTemp()
		return err
	}
	if err := tmp.Close(); err != nil {
		removeTemp()
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		removeTemp()
		return err
	}
	return nil
}
