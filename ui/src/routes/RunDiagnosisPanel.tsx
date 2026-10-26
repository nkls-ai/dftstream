// Failure diagnosis panel (roadmap P1-3): renders the wrapper's deterministic
// error classification as a plain-English cause, the output excerpt, links
// into the ORCA manual / Input Library, and a concrete remedy. Shown at the
// top of the Overview tab for every terminal-failed run, so a dead run
// explains itself where the user lands first.

import type { ReactNode } from "react";
import type { Run } from "../data/types";
import {
  MANUAL_TROUBLESHOOTING_LINK,
  diagnosisFor,
  errorClassLabel,
  resolveRemedyCommand,
  type Diagnosis,
  type DiagnosisLink,
  type Remedy,
} from "../lib/diagnosis";
import { Callout, CopyButton, Section } from "./runDetailUi";

/** Excerpts longer than this start collapsed behind a disclosure. The wrapper
 *  caps excerpts at 600 bytes, so "long" here means "would push the remedy
 *  below the fold". */
const EXCERPT_COLLAPSE_CHARS = 280;

export function RunDiagnosisPanel({ run }: { run: Run }) {
  if (run.status !== "failed") return null;
  const diag = diagnosisFor(run.errorClass);
  return diag ? (
    <KnownDiagnosis run={run} diag={diag} />
  ) : (
    <UnclassifiedDiagnosis run={run} />
  );
}

function KnownDiagnosis({ run, diag }: { run: Run; diag: Diagnosis }) {
  return (
    <Section title="Why this run failed">
      <Callout tone="bad" icon="✕">
        <strong>{diag.title}</strong>
      </Callout>
      <DiagnosisBody>
        <p style={{ margin: 0 }}>{diag.cause}</p>
        {diag.severityNote && (
          <Callout tone="warn">{diag.severityNote}</Callout>
        )}
        <ExcerptBlock excerpt={run.errorExcerpt} />
        {diag.remedies.map((remedy, i) => (
          <RemedyBlock key={i} remedy={remedy} run={run} />
        ))}
        <LinkRow links={diag.links} />
      </DiagnosisBody>
    </Section>
  );
}

/** Fallback for a failed run with no errorClass, or one reported by a newer
 *  wrapper this build predates: excerpt-only, but never a dead end — the
 *  manual troubleshooting link is always offered. */
function UnclassifiedDiagnosis({ run }: { run: Run }) {
  const cls = run.errorClass?.trim();
  return (
    <Section title="Why this run failed">
      <Callout tone="bad" icon="✕">
        <strong>{cls ? errorClassLabel(cls) : "The run failed"}</strong>
        {!cls && (
          <span className="muted">
            {" "}
            — no diagnosis was recorded for this run
            {run.exitCode != null ? ` (exit code ${run.exitCode})` : ""}.
          </span>
        )}
      </Callout>
      <DiagnosisBody>
        {cls ? (
          <p style={{ margin: 0 }}>
            This failure class was reported by a newer dftstream wrapper than
            this interface knows. The output excerpt below and the manual are
            the best starting points.
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            Nothing in the output matched a known failure pattern. Read the
            excerpt below and the tail of the .out file — the last lines before
            the silence usually say which step was underway.
          </p>
        )}
        <ExcerptBlock excerpt={run.errorExcerpt} />
        <LinkRow links={[MANUAL_TROUBLESHOOTING_LINK]} />
      </DiagnosisBody>
    </Section>
  );
}

function DiagnosisBody({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "12px 2px 0",
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

function ExcerptBlock({ excerpt }: { excerpt?: string }) {
  const text = excerpt?.trim();
  if (!text) return null;
  const pre = (
    <pre
      className="mono"
      style={{
        margin: 0,
        padding: "8px 12px",
        background: "var(--hover-wash)",
        borderRadius: 6,
        fontSize: 12,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowX: "auto",
      }}
    >
      {text}
    </pre>
  );
  if (text.length <= EXCERPT_COLLAPSE_CHARS) {
    return (
      <div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          ORCA output around the diagnosis
        </div>
        {pre}
      </div>
    );
  }
  return (
    <details>
      <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
        ORCA output around the diagnosis ({text.split("\n").length} lines)
      </summary>
      <div style={{ marginTop: 4 }}>{pre}</div>
    </details>
  );
}

function RemedyBlock({ remedy, run }: { remedy: Remedy; run: Run }) {
  if (remedy.kind === "cli") {
    const command = resolveRemedyCommand(remedy.command, run);
    return (
      <div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Fix from the command line
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            background: "var(--hover-wash)",
            borderRadius: 6,
          }}
        >
          <code
            className="mono"
            style={{ flex: 1, fontSize: 12, wordBreak: "break-all" }}
          >
            {command}
          </code>
          <CopyButton text={command} title="Copy command" label="copy" />
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {remedy.explanation}
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
        Fix in the input file
      </div>
      <p style={{ margin: 0 }}>{remedy.description}</p>
      {remedy.keywords.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {remedy.keywords.map((kw) => (
            <code
              key={kw}
              className="mono"
              style={{
                padding: "2px 8px",
                background: "var(--hover-wash)",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              {kw}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkRow({ links }: { links: DiagnosisLink[] }) {
  if (links.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12 }}>
      {links.map((l) => (
        <a key={l.href} href={l.href} target="_blank" rel="noreferrer">
          {l.label} ↗
        </a>
      ))}
    </div>
  );
}
