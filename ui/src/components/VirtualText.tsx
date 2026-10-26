import {
  forwardRef,
  type ReactNode,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

export interface VirtualTextHandle {
  scrollToLine: (lineIdx: number) => void;
  lineCount: number;
}

interface Props {
  text?: string;
  // Pre-split lines, used when content is streamed in incrementally so we
  // never re-split a growing multi-MB string on every update (O(n²)). Takes
  // precedence over `text` when provided.
  lines?: string[];
  height?: number;
  lineHeight?: number;
  showGutter?: boolean;
  renderLine?: (line: string, lineIdx: number) => ReactNode;
  lineClassName?: (line: string, lineIdx: number) => string | undefined;
}

/**
 * Windowed text viewer. Splits text on '\n' and only renders the lines
 * currently in the scroll viewport (+ a small overscan). Handles
 * multi-MB outputs without freezing the page. Pass `lines` instead of `text`
 * for streamed content to skip the per-update split.
 */
export const VirtualText = forwardRef<VirtualTextHandle, Props>(
  function VirtualText(
    {
      text,
      lines: linesProp,
      height = 540,
      lineHeight = 18,
      showGutter = true,
      renderLine,
      lineClassName,
    },
    ref,
  ) {
    const splitLines = useMemo(
      () => (linesProp ? null : (text ?? "").split("\n")),
      [linesProp, text],
    );
    const lines = linesProp ?? splitLines ?? [];
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);

    useImperativeHandle(
      ref,
      () => ({
        scrollToLine: (n: number) => {
          if (containerRef.current) {
            containerRef.current.scrollTop = Math.max(0, n) * lineHeight;
          }
        },
        lineCount: lines.length,
      }),
      [lines.length, lineHeight],
    );

    const overscan = 30;
    const startIdx = Math.max(
      0,
      Math.floor(scrollTop / lineHeight) - overscan,
    );
    const endIdx = Math.min(
      lines.length,
      Math.ceil((scrollTop + height) / lineHeight) + overscan,
    );
    const slice = lines.slice(startIdx, endIdx);
    const totalH = lines.length * lineHeight;
    const offsetY = startIdx * lineHeight;
    const gutterWidth = showGutter
      ? Math.max(36, String(lines.length).length * 8 + 16)
      : 0;

    return (
      <div
        ref={containerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="virtual-text"
        style={{ height }}
      >
        <div
          style={{
            height: totalH,
            position: "relative",
            minWidth: "max-content",
          }}
        >
          <div style={{ position: "absolute", top: offsetY, left: 0 }}>
            {slice.map((line, i) => {
              const lineIdx = startIdx + i;
              const lineNo = lineIdx + 1;
              const extraClass = lineClassName?.(line, lineIdx);
              return (
                <div
                  key={lineNo}
                  className={["vt-row", extraClass].filter(Boolean).join(" ")}
                  style={{ height: lineHeight }}
                >
                  {showGutter && (
                    <span className="vt-gutter" style={{ width: gutterWidth }}>
                      {lineNo}
                    </span>
                  )}
                  <span className="vt-line">
                    {renderLine ? renderLine(line, lineIdx) : line || "​"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  },
);
