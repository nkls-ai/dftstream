import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/useDismiss";

export interface MenuItem {
  label: string;
  onClick: () => void;
  /** Visual treatment — "danger" gets a red tint. */
  tone?: "default" | "danger";
}

/**
 * A compact three-dot button that opens a popover menu of actions.
 *
 * The popover is rendered into a portal at document.body so it isn't
 * clipped by the parent card's stacking context or by any ancestor
 * with overflow:hidden / transform — both common in our grid layout
 * (sibling .exp-cards with hover:transform would otherwise paint
 * over an earlier card's open menu, and bottom-of-page cards would
 * have the popover hidden under the main scroll container).
 *
 * Position is computed from the trigger's bounding rect each time the
 * menu opens. If there isn't room below, it flips to render upward.
 */
function swallow(ev: React.MouseEvent) {
  ev.stopPropagation();
  ev.preventDefault();
}

export function RowMenu({
  items,
  ariaLabel = "more actions",
}: {
  items: MenuItem[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    placement: "below" | "above";
  } | null>(null);

  const place = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const popH = popRef.current?.getBoundingClientRect().height ?? 80;
    const popW = popRef.current?.getBoundingClientRect().width ?? 160;
    const gap = 4;
    const below = rect.bottom + gap + popH <= window.innerHeight;
    const top = below ? rect.bottom + gap : rect.top - gap - popH;
    // Right-align to the trigger; clamp to viewport.
    let left = rect.right - popW;
    left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));
    setPos({ top, left, placement: below ? "below" : "above" });
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useDismiss(open, () => setOpen(false), [popRef, btnRef]);


  return (
    <span className="row-menu" onClick={swallow}>
      <button
        ref={btnRef}
        type="button"
        className={"row-menu-btn" + (open ? " active" : "")}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={(e) => {
          swallow(e);
          setOpen((x) => !x);
        }}
      >
        <DotsIcon />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="row-menu-pop"
            role="menu"
            style={{
              position: "fixed",
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
            }}
            onClick={swallow}
          >
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={
                  "row-menu-item" + (it.tone === "danger" ? " danger" : "")
                }
                onClick={(e) => {
                  swallow(e);
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

function DotsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}
