"use client";

import { useState } from "react";

import { SITE } from "@/lib/nav";

enum CopyState {
  Idle = "idle",
  Copied = "copied",
  Failed = "failed",
}

const LABEL: Record<CopyState, string> = {
  [CopyState.Idle]: "copy",
  [CopyState.Copied]: "copied",
  [CopyState.Failed]: "copy failed",
};

export function InstallCommand() {
  const [state, setState] = useState<CopyState>(CopyState.Idle);

  function copy() {
    // Clipboard is blocked in insecure contexts and by some browsers; surface
    // the failure so the reader knows to select the text by hand.
    navigator.clipboard
      .writeText(SITE.installCommand)
      .then(() => {
        setState(CopyState.Copied);
        window.setTimeout(() => setState(CopyState.Idle), 2000);
      })
      .catch((err: unknown) => {
        console.error("Clipboard copy failed:", err);
        setState(CopyState.Failed);
        window.setTimeout(() => setState(CopyState.Idle), 3000);
      });
  }

  return (
    <div className="os-sunken flex items-stretch overflow-hidden">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-3.5 py-3 font-mono text-[12px] text-text">
        <span className="mr-2 select-none text-faint">$</span>
        {SITE.installCommand}
      </code>
      <button
        type="button"
        onClick={copy}
        className={`shrink-0 border-l border-line-soft px-3.5 font-mono text-[11px] transition-colors ${
          state === CopyState.Failed ? "text-danger" : "text-muted hover:text-accent"
        }`}
      >
        {LABEL[state]}
      </button>
    </div>
  );
}
