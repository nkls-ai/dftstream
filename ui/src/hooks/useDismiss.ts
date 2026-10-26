import { useEffect, useRef, type RefObject } from "react";

/**
 * Close-on-outside-click (and optionally Escape) for popovers/dropdowns.
 * `refs` are the elements that count as "inside" — a mousedown outside all
 * of them (or an Escape keypress) calls `onDismiss`. Listeners are only
 * attached while `active`; `onDismiss`/`refs` are read through a ref so
 * callers can pass inline arrows without re-subscribing every render.
 */
export function useDismiss(
  active: boolean,
  onDismiss: () => void,
  refs: RefObject<Element | null>[],
  { escape = true }: { escape?: boolean } = {},
): void {
  const latest = useRef({ onDismiss, refs });
  useEffect(() => {
    latest.current = { onDismiss, refs };
  });

  useEffect(() => {
    if (!active) return;
    const onDoc = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (latest.current.refs.some((r) => r.current?.contains(t))) return;
      latest.current.onDismiss();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") latest.current.onDismiss();
    };
    document.addEventListener("mousedown", onDoc);
    if (escape) document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      if (escape) document.removeEventListener("keydown", onKey);
    };
  }, [active, escape]);
}
