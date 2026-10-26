import { useMemo, useState } from "react";
import { useDataSource } from "../data/DataSource";
import {
  buildUnifiedLog,
  uniqueEventKinds,
  uniqueLogLevels,
  type LogView,
} from "./logEntries";
import { Section } from "./runDetailUi";
import { RunLogEntryRow } from "./RunLogEntryRow";
import { RunLogFilterPills } from "./RunLogFilterPills";
import { useSettings } from "../lib/settings";

export function LogTab({ runId }: { runId: string }) {
  const ds = useDataSource();
  const run = ds.useRun(runId);
  const events = ds.useRunEvents(runId);
  const logs = ds.useRunLogs(runId);
  const [{ timeFormat }] = useSettings();
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<string | null>(null);
  const [view, setView] = useState<LogView>("all");

  const kinds = useMemo(() => uniqueEventKinds(events.data), [events.data]);
  const levels = useMemo(() => uniqueLogLevels(logs.data), [logs.data]);

  const unified = useMemo(
    () => buildUnifiedLog(events.data, logs.data, { query, kindFilter, levelFilter, view }),
    [events.data, logs.data, query, kindFilter, levelFilter, view],
  );

  const eventCount = events.data?.length ?? 0;
  const logCount = logs.data?.length ?? 0;

  const dftstreamVersion = run.data?.dftstreamVersion;
  const orcaVersion = run.data?.orcaVersion;
  const logSub = (
    <span>
      {`${unified.length} entries`}
      {dftstreamVersion && (
        <span className="mono muted" style={{ marginLeft: 8 }}>
          · dftstream {dftstreamVersion}
        </span>
      )}
      {orcaVersion && (
        <span className="mono muted" style={{ marginLeft: 8 }}>
          · ORCA {orcaVersion}
        </span>
      )}
    </span>
  );

  return (
    <div className="tab-shell">
      <Section
        title="Log"
        sub={logSub}
      >
        <div className="event-toolbar">
          <div className="scf-pills">
            <button
              type="button"
              className={"scf-pill" + (view === "all" ? " active" : "")}
              onClick={() => { setView("all"); setKindFilter(null); setLevelFilter(null); }}
            >
              all ({eventCount + logCount})
            </button>
            <button
              type="button"
              className={"scf-pill" + (view === "events" ? " active" : "")}
              onClick={() => { setView("events"); setLevelFilter(null); }}
            >
              events ({eventCount})
            </button>
            <button
              type="button"
              className={"scf-pill" + (view === "wrapper" ? " active" : "")}
              onClick={() => { setView("wrapper"); setKindFilter(null); }}
            >
              wrapper ({logCount})
            </button>
          </div>
          <input aria-label="Filter wrapper logs"
            type="search"
            placeholder="Filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {view !== "wrapper" && kinds.length > 0 && (
          <RunLogFilterPills
            allLabel="all kinds"
            values={kinds}
            active={kindFilter}
            onSelect={setKindFilter}
          />
        )}
        {view !== "events" && levels.length > 0 && (
          <RunLogFilterPills
            allLabel="all levels"
            values={levels}
            active={levelFilter}
            onSelect={setLevelFilter}
            pillClass="scf-pill log-level-pill"
          />
        )}
        <div className="event-table" role="log">
          {unified.length === 0 ? (
            <div
              className="dim"
              style={{ padding: 16, fontFamily: "var(--mono)" }}
            >
              {(events.data == null || logs.data == null)
                ? "loading…"
                : "no entries match the current filter"}
            </div>
          ) : (
            unified.map((entry) => (
              <RunLogEntryRow
                key={entry.type === "event" ? `ev-${entry.id}` : `log-${entry.id}`}
                entry={entry}
                timeFormat={timeFormat}
              />
            ))
          )}
        </div>
      </Section>
    </div>
  );
}
