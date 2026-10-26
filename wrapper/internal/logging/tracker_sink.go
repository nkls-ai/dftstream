package logging

import (
	"context"

	"github.com/nkls-ai/dftstream/internal/tracker"
)

// TrackerSink writes log entries to the tracker backend for persistence.
// It only needs the log-append capability, not the full Tracker.
type TrackerSink struct {
	Tracker tracker.LogAppender
	RunID   tracker.RunID
}

func (s *TrackerSink) WriteEntries(ctx context.Context, entries []Entry) error {
	if s.Tracker == nil || s.RunID == "" {
		return nil
	}
	items := make([]tracker.LogEntry, len(entries))
	for i, e := range entries {
		items[i] = tracker.LogEntry{
			TS:      e.TS,
			Level:   e.Level.String(),
			Message: e.Message,
			Fields:  e.Fields,
		}
	}
	return s.Tracker.AppendLogs(ctx, s.RunID, items)
}
