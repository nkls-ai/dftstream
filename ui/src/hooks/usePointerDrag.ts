import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

export interface PointerDragHandlers {
  /** Called once on pointerdown (after preventDefault). */
  onStart?: (e: ReactPointerEvent) => void;
  /** Called for every pointermove while the drag is active. */
  onMove: (ev: PointerEvent) => void;
  /** Called when the drag ends (pointerup). Not called on unmount teardown. */
  onEnd?: () => void;
}

/**
 * Document-level pointer drag: returns an onPointerDown handler that wires
 * pointermove/pointerup listeners for the duration of the drag. In-flight
 * listeners are torn down if the component unmounts mid-drag — otherwise
 * they keep firing setState against a dead component.
 */
export function usePointerDrag(handlers: PointerDragHandlers): (e: ReactPointerEvent) => void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  return useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    handlersRef.current.onStart?.(e);
    const onMove = (ev: PointerEvent) => handlersRef.current.onMove(ev);
    const teardown = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      dragCleanup.current = null;
    };
    const onUp = () => {
      teardown();
      handlersRef.current.onEnd?.();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    dragCleanup.current = teardown;
  }, []);
}
