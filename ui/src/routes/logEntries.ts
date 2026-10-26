import type { RunEvent, RunLog } from "../data/types";

export type LogView = "events" | "wrapper" | "all";

export type UnifiedLogEntry =
  | { type: "event"; id: string; ts: number; kind: string; payload: Record<string, unknown> }
  | { type: "log"; id: string; ts: number; level: string; message: string; fields?: Record<string, unknown> };

export interface UnifiedLogFilter {
  query: string;
  kindFilter: string | null;
  levelFilter: string | null;
  view: LogView;
}

export function uniqueEventKinds(events: RunEvent[] | undefined): string[] {
  const set = new Set<string>();
  for (const e of events ?? []) set.add(e.kind);
  return Array.from(set).sort();
}

export function uniqueLogLevels(logs: RunLog[] | undefined): string[] {
  const set = new Set<string>();
  for (const l of logs ?? []) set.add(l.level);
  return Array.from(set).sort();
}

export function buildUnifiedLog(
  events: RunEvent[] | undefined,
  logs: RunLog[] | undefined,
  { query, kindFilter, levelFilter, view }: UnifiedLogFilter,
): UnifiedLogEntry[] {
  const q = query.toLowerCase();
  const out: UnifiedLogEntry[] = [];

  if (view !== "wrapper") {
    for (const e of events ?? []) {
      if (kindFilter && e.kind !== kindFilter) continue;
      if (q && !e.kind.toLowerCase().includes(q) && !JSON.stringify(e.payload).toLowerCase().includes(q)) continue;
      out.push({ type: "event", id: e.id, ts: e.ts, kind: e.kind, payload: e.payload });
    }
  }

  if (view !== "events") {
    for (const l of logs ?? []) {
      if (levelFilter && l.level !== levelFilter) continue;
      if (q && !l.message.toLowerCase().includes(q) && !l.level.toLowerCase().includes(q)
        && !(l.fields && JSON.stringify(l.fields).toLowerCase().includes(q))) continue;
      out.push({ type: "log", id: l.id, ts: l.ts, level: l.level, message: l.message, fields: l.fields });
    }
  }

  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export function formatFieldValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

export function summarizePayload(payload: Record<string, unknown>): string {
  if (!payload || typeof payload !== "object") return "";
  const keys = Object.keys(payload);
  if (keys.length === 0) return "";
  const parts: string[] = [];
  const pull = (k: string) => {
    if (k in payload && payload[k] != null) {
      const v = payload[k];
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      parts.push(`${k}=${s}`);
    }
  };
  for (const k of ["cycle", "iter", "energy", "wavenumber", "status", "exitCode", "message", "name", "kind"]) {
    if (parts.length >= 4) break;
    pull(k);
  }
  for (const k of keys) {
    if (parts.length >= 4) break;
    if (["cycle", "iter", "energy", "wavenumber", "status", "exitCode", "message", "name", "kind"].includes(k)) continue;
    pull(k);
  }
  const out = parts.join("  ");
  return out.length > 240 ? out.slice(0, 237) + "…" : out;
}
