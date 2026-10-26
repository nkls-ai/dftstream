import { highlightOrcaLine, type OrcaSyntaxMode } from "./highlight";
import { renderTokens } from "./orcaRender";

export function OrcaHighlightedText({
  text,
  mode,
  className = "",
}: {
  text: string;
  mode: OrcaSyntaxMode;
  className?: string;
}) {
  const lines = text.split("\n");
  // Key by each line's start offset in the source text — a stable identity that
  // survives appends/edits (offsets are monotonic, blank lines still advance by
  // the consumed "\n"), unlike the iteration index.
  let offset = 0;
  return (
    <div className={`orca-code ${className}`.trim()}>
      {lines.map((line) => {
        const start = offset;
        offset += line.length + 1;
        const highlighted = highlightOrcaLine(line, mode);
        return (
          <div
            key={start}
            className={["orca-code-line", highlighted.className]
              .filter(Boolean)
              .join(" ")}
          >
            {renderTokens(highlighted.tokens)}
          </div>
        );
      })}
    </div>
  );
}
