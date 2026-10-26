import { formatFieldValue, summarizePayload, type UnifiedLogEntry } from "./logEntries";
import { formatTimeOfDaySetting, type TimeFormat } from "../lib/settings";

export function RunLogEntryRow({ entry, timeFormat }: { entry: UnifiedLogEntry; timeFormat: TimeFormat }) {
  if (entry.type === "event") {
    return (
      <div className="event-row">
        <span className="event-time">
          {formatTimeOfDaySetting(entry.ts, timeFormat)}
        </span>
        <span className={`event-kind ev-${entry.kind}`}>{entry.kind}</span>
        <span className="event-payload">
          {summarizePayload(entry.payload)}
        </span>
      </div>
    );
  }
  return (
    <div className={`event-row log-row log-${entry.level}`}>
      <span className="event-time">
        {formatTimeOfDaySetting(entry.ts, timeFormat)}
      </span>
      <span className={`event-kind log-level log-level-${entry.level}`}>{entry.level}</span>
      <span className="event-payload log-body">
        <span className="log-message">{entry.message}</span>
        {entry.fields && Object.keys(entry.fields).length > 0 && (
          <span className="log-fields">
            {Object.entries(entry.fields).map(([k, v]) => (
              <span key={k} className="log-field-tag">
                <span className="log-field-key">{k}</span>
                <span className="log-field-val">{formatFieldValue(v)}</span>
              </span>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}
