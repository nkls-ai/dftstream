package logging

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
	LevelOff // disables all logging entirely
)

func (l Level) String() string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelInfo:
		return "info"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	case LevelOff:
		return "off"
	default:
		return "unknown"
	}
}

func ParseLevel(s string) (Level, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug", "d", "trace":
		return LevelDebug, nil
	case "info", "i":
		return LevelInfo, nil
	case "warn", "warning", "w":
		return LevelWarn, nil
	case "error", "err", "e":
		return LevelError, nil
	case "off", "none":
		return LevelOff, nil
	case "":
		return LevelWarn, nil
	default:
		return LevelWarn, fmt.Errorf("unknown log level %q (use debug|info|warn|error|off)", s)
	}
}

type Entry struct {
	TS      time.Time
	Level   Level
	Message string
	Fields  map[string]any
}

type Sink interface {
	WriteEntries(ctx context.Context, entries []Entry) error
}

type Logger struct {
	level  Level
	stderr io.Writer
	sinks  []Sink
	mu     sync.Mutex
	buf    []Entry
}

func New(level Level, sinks ...Sink) *Logger {
	return &Logger{
		level:  level,
		stderr: os.Stderr,
		sinks:  sinks,
	}
}

func (l *Logger) SetStderr(w io.Writer) {
	l.mu.Lock()
	l.stderr = w
	l.mu.Unlock()
}

func (l *Logger) Level() Level { return l.level }

func (l *Logger) Debug(msg string, fields ...map[string]any) {
	l.log(LevelDebug, msg, fields)
}

func (l *Logger) Info(msg string, fields ...map[string]any) {
	l.log(LevelInfo, msg, fields)
}

func (l *Logger) Warn(msg string, fields ...map[string]any) {
	l.log(LevelWarn, msg, fields)
}

func (l *Logger) Error(msg string, fields ...map[string]any) {
	l.log(LevelError, msg, fields)
}

func (l *Logger) log(level Level, msg string, fields []map[string]any) {
	if l.level == LevelOff || level < l.level {
		return
	}
	entry := Entry{
		TS:      time.Now(),
		Level:   level,
		Message: msg,
	}
	if len(fields) > 0 && fields[0] != nil {
		entry.Fields = fields[0]
	}

	// Hold the lock across the stderr write AND the buffer append: the logger
	// is shared by the runner, parser pump and sysinfo sampler goroutines, so
	// an unlocked write both races l.stderr (SetStderr) and interleaves bytes
	// from concurrent log lines.
	l.mu.Lock()
	l.writeStderr(entry)
	l.buf = append(l.buf, entry)
	l.mu.Unlock()
}

// SystemInfo logs system metadata at Info level. Always buffered for DB
// persistence (needed for crash analysis) but only printed to stderr if
// the configured level is Info or lower. Completely skipped when level
// is Off.
func (l *Logger) SystemInfo(msg string, fields map[string]any) {
	if l.level == LevelOff {
		return
	}
	entry := Entry{
		TS:      time.Now(),
		Level:   LevelInfo,
		Message: msg,
		Fields:  fields,
	}
	l.mu.Lock()
	if LevelInfo >= l.level {
		l.writeStderr(entry)
	}
	l.buf = append(l.buf, entry)
	l.mu.Unlock()
}

func (l *Logger) writeStderr(e Entry) {
	if l.stderr == nil {
		return
	}
	ts := e.TS.Format("15:04:05")
	prefix := fmt.Sprintf("[dftstream %s %s] ", ts, e.Level)
	var sb strings.Builder
	sb.WriteString(prefix)
	sb.WriteString(e.Message)
	if len(e.Fields) > 0 {
		sb.WriteString(" {")
		first := true
		for k, v := range e.Fields {
			if !first {
				sb.WriteString(", ")
			}
			fmt.Fprintf(&sb, "%s=%v", k, v)
			first = false
		}
		sb.WriteString("}")
	}
	sb.WriteByte('\n')
	fmt.Fprint(l.stderr, sb.String())
}

// Flush sends all buffered entries to registered sinks and clears the
// buffer. Called at the end of a run to persist logs to the DB.
func (l *Logger) Flush(ctx context.Context) error {
	l.mu.Lock()
	entries := l.buf
	l.buf = nil
	l.mu.Unlock()

	if len(entries) == 0 || len(l.sinks) == 0 {
		return nil
	}

	var errs []error
	for _, s := range l.sinks {
		if err := s.WriteEntries(ctx, entries); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) == 1 {
		return errs[0]
	}
	if len(errs) > 1 {
		msgs := make([]string, len(errs))
		for i, e := range errs {
			msgs[i] = e.Error()
		}
		return fmt.Errorf("multiple sink errors: %s", strings.Join(msgs, "; "))
	}
	return nil
}

// Entries returns a copy of all buffered entries (for testing).
func (l *Logger) Entries() []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Entry, len(l.buf))
	copy(out, l.buf)
	return out
}
