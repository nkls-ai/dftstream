import { useEffect, useRef, useState } from "react";
import type { Run } from "../data/types";
import { useDataSource } from "../data/DataSource";
import { reportError } from "../lib/errorReporting";
import { Section } from "./runDetailUi";

/**
 * Tag chips on the run header: click × to remove, "+ tag" to add inline.
 * Optimistic — the chip row reflects the local edit immediately and rolls
 * back if the mutation fails.
 */
export function RunTagsEditor({ run }: { run: Run }) {
  const ds = useDataSource();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const tags = draft ?? run.tags ?? [];

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const commit = (next: string[]) => {
    setDraft(next);
    ds.setRunTags(run.id, next)
      .then(() => setDraft(null))
      .catch((err) => {
        setDraft(null); // roll back to the server state
        reportError(err, { source: "run-annotations", action: "save tags" });
      });
  };

  const addTag = () => {
    const t = input.trim();
    setInput("");
    setAdding(false);
    if (!t || tags.includes(t)) return;
    commit([...tags, t]);
  };

  return (
    <span className="run-tags">
      {tags.map((t) => (
        <span key={t} className="tag-pill run-tag">
          {t}
          <button
            type="button"
            className="run-tag-remove"
            aria-label={`Remove tag ${t}`}
            title="Remove tag"
            onClick={() => commit(tags.filter((x) => x !== t))}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          ref={inputRef}
          className="run-tag-input"
          value={input}
          placeholder="tag name"
          maxLength={40}
          onChange={(e) => setInput(e.target.value)}
          onBlur={addTag}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTag();
            if (e.key === "Escape") {
              setInput("");
              setAdding(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="tag-pill run-tag-add"
          onClick={() => setAdding(true)}
          title="Add a tag"
        >
          + tag
        </button>
      )}
    </span>
  );
}

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

/**
 * Free-text notes on a run — the lab-notebook margin. Saves on blur or
 * Ctrl/Cmd-Enter; plain text with whitespace preserved.
 */
export function RunNotesSection({ run }: { run: Run }) {
  const ds = useDataSource();
  const [text, setText] = useState(run.notes ?? "");
  const [state, setState] = useState<SaveState>("clean");
  const editedRef = useRef(false);

  // Follow server updates (another client edited) unless a local edit is
  // in progress.
  useEffect(() => {
    if (!editedRef.current) setText(run.notes ?? "");
  }, [run.notes]);

  const save = () => {
    if (text === (run.notes ?? "")) {
      setState("clean");
      editedRef.current = false;
      return;
    }
    setState("saving");
    ds.setRunNotes(run.id, text)
      .then(() => {
        setState("saved");
        editedRef.current = false;
      })
      .catch((err) => {
        setState("error");
        reportError(err, { source: "run-annotations", action: "save notes" });
      });
  };

  const hasContent = text.length > 0 || (run.notes ?? "").length > 0;

  return (
    <Section
      title="Notes"
      sub={
        state === "dirty" ? "unsaved — click away or Ctrl+Enter to save"
        : state === "saving" ? "saving…"
        : state === "saved" ? "saved"
        : state === "error" ? <span style={{ color: "rgb(var(--rose))" }}>save failed — retry</span>
        : undefined
      }
    >
      <textarea
        className="run-notes-input"
        value={text}
        rows={hasContent ? Math.min(Math.max(text.split("\n").length + 1, 3), 14) : 2}
        placeholder="Observations, follow-ups, anything the numbers don't say…"
        onChange={(e) => {
          editedRef.current = true;
          setText(e.target.value);
          setState("dirty");
        }}
        onBlur={save}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") save();
        }}
      />
    </Section>
  );
}
