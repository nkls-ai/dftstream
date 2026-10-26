import type { ReactNode } from "react";
import {
  highlightOrcaLine,
  type OrcaSyntaxMode,
  type OrcaToken,
} from "./highlight";

export function renderOrcaLine(
  line: string,
  mode: OrcaSyntaxMode,
): ReactNode {
  const { tokens } = highlightOrcaLine(line, mode);
  return renderTokens(tokens);
}

export function orcaLineClassName(
  line: string,
  mode: OrcaSyntaxMode,
): string | undefined {
  return highlightOrcaLine(line, mode).className;
}

export function renderTokens(tokens: OrcaToken[]): ReactNode {
  if (tokens.length === 0 || tokens.every((token) => token.text === "")) {
    return "\u200b";
  }
  // Key by each token's start column — a stable, content-derived identity that
  // never collides (columns are monotonic), unlike the iteration index.
  let col = 0;
  return tokens.map((token) => {
    const start = col;
    col += token.text.length;
    return token.className ? (
      <span key={start} className={token.className}>
        {token.text}
      </span>
    ) : (
      token.text
    );
  });
}
