import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useDataSource } from "../data/DataSource";
import { orgQueryArg, useOrg } from "../auth/OrgContext";
import { routes } from "../lib/routes";

interface PaletteItem {
  key: string;
  label: string;
  hint: string;
  to: string;
}

/**
 * Cmd/Ctrl-K quick-open: fuzzy-ish (substring) jump to any experiment, a
 * run of the currently open experiment, or a static page. Arrow keys +
 * Enter navigate, Escape closes.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  // Mounted outside <Routes>, so the experiment id comes from the path,
  // not useParams.
  const expIdMatch = location.pathname.match(/^\/experiments\/([^/]+)/);
  const currentExpId = expIdMatch?.[1];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      // Focus after the overlay mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Close on navigation.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const close = useCallback(() => setOpen(false), []);

  if (!open) return null;
  return (
    <PaletteOverlay
      query={query}
      setQuery={setQuery}
      cursor={cursor}
      setCursor={setCursor}
      inputRef={inputRef}
      onNavigate={(to) => {
        close();
        navigate(to);
      }}
      onClose={close}
      currentExpId={currentExpId}
    />
  );
}

// The data-fetching part mounts only while the palette is open, so the
// queries don't run on every page in the background.
function PaletteOverlay({
  query,
  setQuery,
  cursor,
  setCursor,
  inputRef,
  onNavigate,
  onClose,
  currentExpId,
}: {
  query: string;
  setQuery: (q: string) => void;
  cursor: number;
  setCursor: (fn: number | ((c: number) => number)) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onNavigate: (to: string) => void;
  onClose: () => void;
  currentExpId: string | undefined;
}) {
  const ds = useDataSource();
  const org = useOrg();
  const experiments = ds.useExperiments(orgQueryArg(org));
  // Runs of the experiment currently on screen — jumping between sibling
  // runs is the hot path; a global run index would be a heavy query.
  const runs = ds.useRunsByExperiment(currentExpId ?? "skip");

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [
      { key: "page:experiments", label: "Experiments", hint: "page", to: routes.experiments },
      { key: "page:new-input", label: "New input", hint: "page · build an ORCA input", to: routes.newInput },
      { key: "page:tools", label: "Tools", hint: "page", to: routes.tools },
      { key: "page:settings", label: "Settings", hint: "page", to: routes.settings },
    ];
    for (const e of experiments.data ?? []) {
      out.push({
        key: `exp:${e.id}`,
        label: e.name,
        hint: "experiment",
        to: routes.experiment(e.id),
      });
    }
    if (currentExpId) {
      for (const r of runs.data ?? []) {
        out.push({
          key: `run:${r.id}`,
          label: r.name ?? r.id.slice(0, 10),
          hint: `run · ${r.jobType ?? r.status}`,
          to: routes.run(currentExpId, r.id),
        });
      }
    }
    return out;
  }, [experiments.data, runs.data, currentExpId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 12);
    return items
      .filter((i) => i.label.toLowerCase().includes(q) || i.hint.includes(q))
      .slice(0, 12);
  }, [items, query]);

  const clampedCursor = Math.min(cursor, Math.max(0, filtered.length - 1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[clampedCursor];
      if (item) onNavigate(item.to);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Quick open"
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Jump to experiment, run, or page…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" role="listbox">
          {filtered.length === 0 && (
            <div className="palette-empty dim">No matches.</div>
          )}
          {filtered.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={i === clampedCursor}
              className={"palette-item" + (i === clampedCursor ? " active" : "")}
              onMouseEnter={() => setCursor(i)}
              onClick={() => onNavigate(item.to)}
            >
              <span className="palette-item-label">{item.label}</span>
              <span className="palette-item-hint dim">{item.hint}</span>
            </button>
          ))}
        </div>
        <div className="palette-footer dim">↑↓ navigate · Enter open · Esc close</div>
      </div>
    </div>
  );
}
