import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  ActiveDialog,
  AlertOptions,
  ConfirmOptions,
  PromptOptions,
} from "./dialogTypes";
import { DialogShell } from "./DialogShell";

export type { AlertOptions, ConfirmOptions, PromptOptions } from "./dialogTypes";

// ---- Public hooks ---------------------------------------------------------

interface DialogContextValue {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  alert: (opts: AlertOptions) => Promise<void>;
}

const Ctx = createContext<DialogContextValue | null>(null);

export function useConfirm() {
  return useDialogs().confirm;
}
export function usePrompt() {
  return useDialogs().prompt;
}
export function useAlert() {
  return useDialogs().alert;
}
function useDialogs(): DialogContextValue {
  const c = useContext(Ctx);
  if (!c) throw new Error("useDialogs: missing <DialogProvider>");
  return c;
}

// ---- Provider -------------------------------------------------------------

export function DialogProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveDialog | null>(null);

  const activeRef = useRef<ActiveDialog | null>(null);
  activeRef.current = active;

  const close = useCallback(
    (
      kind: ActiveDialog["kind"],
      value: boolean | string | null | undefined,
    ) => {
      const cur = activeRef.current;
      if (!cur || cur.kind !== kind) return;
      activeRef.current = null;
      setActive(null);
      if (cur.kind === "confirm") cur.resolve(Boolean(value));
      else if (cur.kind === "prompt") {
        cur.resolve(typeof value === "string" ? value : null);
      } else {
        cur.resolve();
      }
    },
    [],
  );

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        setActive({ kind: "confirm", opts, resolve }),
      ),
    [],
  );
  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) =>
        setActive({ kind: "prompt", opts, resolve }),
      ),
    [],
  );
  const alert = useCallback(
    (opts: AlertOptions) =>
      new Promise<void>((resolve) =>
        setActive({ kind: "alert", opts, resolve }),
      ),
    [],
  );

  return (
    <Ctx.Provider value={{ confirm, prompt, alert }}>
      {children}
      {active &&
        createPortal(
          <DialogShell
            active={active}
            onCancel={() => {
              if (active.kind === "confirm") close("confirm", false);
              else if (active.kind === "prompt") close("prompt", null);
              else close("alert", undefined);
            }}
            onConfirmResult={(val) => {
              if (active.kind === "confirm") close("confirm", val as boolean);
              else if (active.kind === "prompt") close("prompt", val as string);
              else close("alert", undefined);
            }}
          />,
          document.body,
        )}
    </Ctx.Provider>
  );
}
