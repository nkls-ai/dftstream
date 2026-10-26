/**
 * The app's sidebar mark: a rounded accent tile with a stream glyph. Drawn
 * rather than shipped as an asset so it inherits the accent in both themes.
 */
export function AppMark({ size = 28 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-md"
      style={{
        width: size,
        height: size,
        background: "rgba(var(--os-accent-rgb), 0.14)",
        border: "1px solid rgba(var(--os-accent-rgb), 0.28)",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        style={{ width: size * 0.58, height: size * 0.58 }}
        className="text-accent"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M4 8h13M4 12h16M4 16h9" />
      </svg>
    </span>
  );
}
