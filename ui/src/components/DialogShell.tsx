import { useEffect, useRef, useState } from "react";
import {
  dialogCancelLabel,
  dialogConfirmLabel,
  dialogTone,
  type ActiveDialog,
} from "./dialogTypes";

/**
 * Tab-order members of the dialog card, in document order. Elements that are
 * disabled or explicitly removed from the tab order are skipped, so the trap
 * never parks focus somewhere the browser would not have put it.
 */
export function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const selector =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("tabindex") !== "-1",
  );
}

/** The rendered modal for the active confirm/prompt/alert dialog. */
export function DialogShell({
  active,
  onCancel,
  onConfirmResult,
}: {
  active: ActiveDialog;
  onCancel: () => void;
  onConfirmResult: (val: boolean | string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState(
    active.kind === "prompt" ? (active.opts.defaultValue ?? "") : "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        onCancel();
        return;
      }
      // Focus trap. The dialog is aria-modal but the page behind it stays in
      // the tab order, so Tab walked straight out of a "Delete run?" confirm
      // and onto the runs table underneath — a keyboard user could put focus
      // on a row action while a destructive dialog was still up, with no
      // visible indication of where they were.
      if (ev.key !== "Tab") return;
      const focusables = focusableIn(cardRef.current);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const activeEl = document.activeElement;
      if (ev.shiftKey && (activeEl === first || !cardRef.current?.contains(activeEl))) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && activeEl === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    // Lock background scroll while a dialog is up.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onCancel]);

  useEffect(() => {
    // Remember where focus came from so closing the dialog returns it there,
    // instead of dumping the user back at the top of the document.
    const opener = document.activeElement;
    if (active.kind === "prompt") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      confirmBtnRef.current?.focus();
    }
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, [active.kind]);

  const tone = dialogTone(active);

  const onSubmit = () => {
    if (active.kind === "prompt") {
      const v = value;
      const err = active.opts.validate?.(v) ?? null;
      if (err) {
        setError(err);
        return;
      }
      onConfirmResult(v);
    } else if (active.kind === "confirm") {
      onConfirmResult(true);
    } else {
      onConfirmResult("");
    }
  };

  const title = active.opts.title;
  const message = active.opts.message;
  const confirmLabel = dialogConfirmLabel(active, tone);
  const cancelLabel = dialogCancelLabel(active);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={cardRef}
        className={"dialog-card" + (tone === "danger" ? " danger" : "")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <h3 id="dialog-title" className="dialog-title">
          {title}
        </h3>
        {message != null && <div className="dialog-message">{message}</div>}
        {active.kind === "prompt" && (
          <>
            <input aria-labelledby="dialog-title"
              ref={inputRef}
              className="dialog-input"
              value={value}
              placeholder={active.opts.placeholder}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSubmit();
                }
              }}
            />
            {error && <div className="dialog-error">{error}</div>}
          </>
        )}
        <div className="dialog-actions">
          {cancelLabel && (
            <button
              type="button"
              className="dialog-btn"
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmBtnRef}
            type="button"
            className={
              "dialog-btn primary" + (tone === "danger" ? " danger" : "")
            }
            onClick={onSubmit}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
