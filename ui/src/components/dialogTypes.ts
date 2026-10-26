import type { ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  /** Initial value of the input. */
  defaultValue?: string;
  /** Placeholder when input is empty. */
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Synchronous validator. Return non-empty string to reject. */
  validate?: (value: string) => string | null;
}

export interface AlertOptions {
  title: string;
  message?: ReactNode;
  tone?: "default" | "danger";
}

export type Resolver<T> = (v: T) => void;

export type ActiveDialog =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: Resolver<boolean> }
  | { kind: "prompt"; opts: PromptOptions; resolve: Resolver<string | null> }
  | { kind: "alert"; opts: AlertOptions; resolve: Resolver<void> };

export type DialogTone = "default" | "danger";

/** Visual tone of the dialog; prompts are always neutral. */
export function dialogTone(active: ActiveDialog): DialogTone {
  return active.kind === "confirm"
    ? (active.opts.tone ?? "default")
    : active.kind === "alert"
      ? (active.opts.tone ?? "default")
      : "default";
}

/** Label of the primary button, honoring per-kind defaults. */
export function dialogConfirmLabel(active: ActiveDialog, tone: DialogTone): string {
  return active.kind === "confirm"
    ? (active.opts.confirmLabel ?? (tone === "danger" ? "Delete" : "OK"))
    : active.kind === "prompt"
      ? (active.opts.confirmLabel ?? "Save")
      : "OK";
}

/** Label of the cancel button, or null when the dialog has none (alerts). */
export function dialogCancelLabel(active: ActiveDialog): string | null {
  return active.kind === "confirm"
    ? (active.opts.cancelLabel ?? "Cancel")
    : active.kind === "prompt"
      ? (active.opts.cancelLabel ?? "Cancel")
      : null;
}
