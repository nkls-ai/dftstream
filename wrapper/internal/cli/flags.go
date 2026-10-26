package cli

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func resolve(flagVal, envKey, fallback string) string {
	if flagVal != "" {
		return flagVal
	}
	if v := os.Getenv(envKey); v != "" {
		return v
	}
	return fallback
}

// splitOnDoubleDash splits args at the first standalone "--". Everything
// after is treated as opaque passthrough args.
func splitOnDoubleDash(args []string) (before, after []string) {
	for i, a := range args {
		if a == "--" {
			return args[:i], args[i+1:]
		}
	}
	return args, nil
}

// hoistFlags reorders args so all flag tokens (and their values) come
// before any positionals. Lets `dftstream run h2.inp --exp foo` work.
func hoistFlags(fs *flag.FlagSet, args []string) []string {
	known := map[string]bool{}
	wantsValue := map[string]bool{}
	fs.VisitAll(func(f *flag.Flag) {
		known[f.Name] = true
		// String/Duration/Int flags take a value; Bool doesn't, but the
		// "-name=value" form always works. We treat all non-bool flags as
		// value-taking.
		_, isBool := f.Value.(boolFlag)
		wantsValue[f.Name] = !isBool
	})

	var flags, positional []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "-h", a == "-help", a == "--help":
			flags = append(flags, a)
		case len(a) > 1 && a[0] == '-':
			name := a
			for len(name) > 0 && name[0] == '-' {
				name = name[1:]
			}
			eq := -1
			for j, c := range name {
				if c == '=' {
					eq = j
					break
				}
			}
			base := name
			hasInline := eq >= 0
			if hasInline {
				base = name[:eq]
			}
			flags = append(flags, a)
			if known[base] && wantsValue[base] && !hasInline && i+1 < len(args) {
				flags = append(flags, args[i+1])
				i++
			}
		default:
			positional = append(positional, a)
		}
	}
	out := append(flags, positional...)
	return out
}

// boolFlag is the interface Go's flag package uses to detect boolean flags.
type boolFlag interface {
	IsBoolFlag() bool
}

func parseBatchParams(raw string) (map[string]any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}
	out := map[string]any{}
	for _, part := range strings.Split(trimmed, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, ok := strings.Cut(part, "=")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !ok || key == "" {
			return nil, fmt.Errorf("invalid batch parameter %q", part)
		}
		if b, err := strconv.ParseBool(value); err == nil {
			out[key] = b
			continue
		}
		if n, err := strconv.ParseFloat(value, 64); err == nil {
			out[key] = n
			continue
		}
		out[key] = value
	}
	return out, nil
}
