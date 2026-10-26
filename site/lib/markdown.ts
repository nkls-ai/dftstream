/**
 * The changelog and docs/ are written for GitHub, not for MDX: they contain
 * bare `<run.out>` placeholders and `{...}` fragments that MDX would parse as
 * JSX and fail the build on. Escape those, but never inside code spans or
 * fenced blocks, where MDX does not parse JSX anyway.
 */
export function escapeForMdx(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line
        .split("`")
        .map((segment, index) =>
          index % 2 === 1 ? segment : segment.replace(/</g, "&lt;").replace(/[{}]/g, (c) => `&#${c.charCodeAt(0)};`),
        )
        .join("`");
    })
    .join("\n");
}
