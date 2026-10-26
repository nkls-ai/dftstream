import { useCallback, useRef, useState, type ReactNode } from "react";
import { reportError } from "../lib/errorReporting";
import { usePointerDrag } from "../hooks/usePointerDrag";
import { usePersistedDisclosure } from "../hooks/usePersistedDisclosure";

/** The verdict tones shared by tiles and callouts (convergence badges use
 *  their own ConvBadgeTone: their CSS classes are "failed"/"running"/"noconv"). */
export type Tone = "ok" | "warn" | "bad";
/** Accent tones the HeadlineTile CSS understands. */
export type TileTone = Tone | "accent";
/** Tones the Callout band CSS understands ("info" renders unmodified). */
export type CalloutTone = Tone | "info";

export function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-heading">
        <h2 className="section-title">{title}</h2>
        <div className="section-rule" />
        {sub != null && <div className="section-sub">{sub}</div>}
      </div>
      {children}
    </section>
  );
}

export function CollapsibleSection({
  title,
  sub,
  defaultOpen = true,
  storageKey,
  children,
}: {
  title: string;
  sub?: ReactNode;
  defaultOpen?: boolean;
  /** When set, the open/closed choice is persisted under this key. */
  storageKey?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = usePersistedDisclosure(storageKey, defaultOpen);
  return (
    <section className="section">
      <div
        className="section-heading section-heading-toggle"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
      >
        <span className={"section-chevron" + (open ? " open" : "")}>&#9654;</span>
        <h2 className="section-title">{title}</h2>
        <div className="section-rule" />
        {sub != null && <div className="section-sub">{sub}</div>}
      </div>
      {open && children}
    </section>
  );
}

export function Headline({ children }: { children: ReactNode }) {
  return <div className="headline">{children}</div>;
}

export function HeadlineTile({
  label,
  value,
  unit,
  sub,
  tone,
  title,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: TileTone;
  title?: string;
}) {
  return (
    <div
      className={"headline-tile" + (tone ? ` ${tone}` : "")}
      title={title}
    >
      <div className="headline-tile-label">{label}</div>
      <div className="headline-tile-value">
        <span>{value}</span>
        {unit && <span className="headline-tile-unit">{unit}</span>}
      </div>
      {sub != null && <div className="headline-tile-sub">{sub}</div>}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="statgrid">{children}</div>;
}

export function StatRow({
  k,
  v,
  unit,
  conv,
  full,
  muted,
  title,
}: {
  k: string;
  v: ReactNode;
  unit?: string;
  conv?: ReactNode;
  full?: boolean;
  muted?: boolean;
  title?: string;
}) {
  return (
    <div
      className={"statrow" + (muted ? " muted" : "")}
      title={title}
    >
      <div className="statrow-key">{k}</div>
      <div className={"statrow-value" + (full ? " full" : "")}>
        {v}
        {unit && <span className="unit">{unit}</span>}
        {conv != null && <span className="conv">{conv}</span>}
      </div>
    </div>
  );
}

export function Callout({
  tone = "info",
  icon,
  children,
}: {
  tone?: CalloutTone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const cls = tone === "info" ? "" : tone;
  return (
    <div className={"callout-band" + (cls ? ` ${cls}` : "")}>
      <span className="callout-band-icon">
        {icon ?? (tone === "ok" ? "✓" : tone === "bad" ? "!" : tone === "warn" ? "△" : "•")}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" data-tooltip={text}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
    </span>
  );
}

export function ResizableSplit({
  left,
  right,
  defaultLeftPct = 67,
  minLeftPct = 25,
  maxLeftPct = 75,
}: {
  left: ReactNode;
  right: ReactNode;
  defaultLeftPct?: number;
  minLeftPct?: number;
  maxLeftPct?: number;
}) {
  const [leftPct, setLeftPct] = useState(defaultLeftPct);
  const ref = useRef<HTMLDivElement | null>(null);

  const clampPct = useCallback(
    (pct: number) => Math.min(maxLeftPct, Math.max(minLeftPct, pct)),
    [maxLeftPct, minLeftPct],
  );

  const setFromClientX = useCallback(
    (clientX: number) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      setLeftPct(clampPct(((clientX - rect.left) / rect.width) * 100));
    },
    [clampPct],
  );

  const onPointerDown = usePointerDrag({
    onStart: (e) => setFromClientX(e.clientX),
    onMove: (ev) => setFromClientX(ev.clientX),
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowLeft" ? -4 : 4;
    setLeftPct((pct) => clampPct(pct + delta));
  };

  return (
    <div
      ref={ref}
      className="resizable-split"
      style={{ "--split-left": `${leftPct}%` } as React.CSSProperties}
    >
      <div className="resizable-pane">{left}</div>
      <div
        className="resizable-split-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panels"
        aria-valuemin={minLeftPct}
        aria-valuemax={maxLeftPct}
        aria-valuenow={Math.round(leftPct)}
        aria-valuetext={`${Math.round(leftPct)} percent left panel`}
        tabIndex={0}
        title="Drag to resize panels"
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      <div className="resizable-pane">{right}</div>
    </div>
  );
}

export function CopyButton({
  text,
  title,
  label,
}: {
  text: string;
  title: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (err) {
      reportError(err, {
        source: "run-detail",
        action: "copy text to clipboard",
      });
    }
  };
  return (
    <button type="button"
      className="dl-btn"
      onClick={onClick}
      title={title}
      onMouseUp={(e) => (e.currentTarget as HTMLButtonElement).blur()}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {label && <span>{copied ? "copied" : label}</span>}
    </button>
  );
}

export function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 5 5 9-11" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}
