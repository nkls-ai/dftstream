import { useState } from "react";
import { downloadText } from "../lib/download";
import { OrcaHighlightedText } from "../syntax/orca/OrcaHighlightedText";
import { LintSeverity, type LintFinding } from "../lib/inputBuilder/lint";
import type { GeneratedFile } from "../lib/inputBuilder/builderState";

/**
 * The generated input, hand-editable, with the pre-flight findings
 * beside it. The text is the deliverable: everything above it is a way
 * to type it faster, and nothing stops the user from taking over.
 *
 * Read mode shows the same ORCA syntax highlighting the artifact viewer
 * uses; Edit swaps in the textarea. The lint findings follow whatever is
 * in the box either way — highlighting must never imply the text was
 * checked less.
 */
export function InputBuilderPreview({
  text,
  edited,
  findings,
  files,
  submitCommand,
  onEdit,
  onRegenerate,
}: {
  text: string;
  edited: boolean;
  findings: LintFinding[];
  files: GeneratedFile[];
  /** The exact `dftstream submit …` line for this input. */
  submitCommand: string;
  onEdit: (text: string) => void;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = useState<"" | "input" | "command">("");
  const [editing, setEditing] = useState(false);

  function copy(what: "input" | "command", value: string) {
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(what);
        window.setTimeout(() => setCopied(""), 1500);
      },
      (err: unknown) => {
        // Clipboard access can be denied (insecure context, permissions);
        // the text is right there to select, so this is not worth an alert.
        console.error("copy to clipboard failed", err);
      },
    );
  }

  return (
    <div className="ib-preview">
      <div className="ib-preview-bar">
        <strong>{files[0]?.name ?? "input.inp"}</strong>
        {edited && <span className="ib-badge">hand-edited</span>}
        <span className="ib-preview-actions">
          {edited && (
            <button
              type="button"
              className="dl-btn"
              onClick={onRegenerate}
              title="Discard the edits and rebuild from the settings above"
            >
              Regenerate
            </button>
          )}
          <button type="button" className="dl-btn" onClick={() => setEditing((e) => !e)}>
            {editing ? "Done editing" : "Edit"}
          </button>
          <button type="button" className="dl-btn" onClick={() => copy("input", text)}>
            {copied === "input" ? "Copied" : "Copy"}
          </button>
          {files.map((f) => (
            <button key={f.name} type="button" className="dl-btn" onClick={() => downloadText(f.name, f.content)}>
              ↓ {f.name}
            </button>
          ))}
        </span>
      </div>

      {editing ? (
        <textarea
          className="mono ib-preview-text"
          spellCheck={false}
          aria-label="Generated ORCA input"
          value={text}
          onChange={(e) => onEdit(e.target.value)}
        />
      ) : (
        <div className="ib-preview-text ib-preview-read">
          <OrcaHighlightedText text={text} mode="input" />
        </div>
      )}

      <div className="ib-findings-panel">
        {findings.length === 0 ? (
          <div className="ib-finding ok">No pre-flight problems found.</div>
        ) : (
          <ul className="ib-findings">
            {findings.map((f, i) => (
              <li key={`${f.code}-${i}`} className={`ib-finding ${severityClass(f.severity)}`}>
                <span className="ib-finding-code">{f.code}</span>
                {f.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="ib-submit">
        <div className="ib-preview-bar">
          <strong>Submit</strong>
          <span className="ib-preview-actions">
            {files.map((f) => (
              <button
                key={f.name}
                type="button"
                className="button"
                onClick={() => downloadText(f.name, f.content)}
              >
                ↓ {f.name}
              </button>
            ))}
            <button type="button" className="dl-btn" onClick={() => copy("command", submitCommand)}>
              {copied === "command" ? "Copied" : "Copy command"}
            </button>
          </span>
        </div>
        <code className="ib-submit-command mono">{submitCommand}</code>
        <span className="dim">
          {files.length > 1
            ? "Download the files into the same directory, then run the command from there."
            : "Download the file, then run the command from its directory."}
        </span>
      </div>
    </div>
  );
}

function severityClass(severity: LintSeverity): string {
  switch (severity) {
    case LintSeverity.Error:
      return "error";
    case LintSeverity.Warn:
      return "warn";
    default:
      return "info";
  }
}
