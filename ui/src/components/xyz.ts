/**
 * Parses the atom positions of a single-frame XYZ string into [x, y, z]
 * tuples (element symbols are dropped). Returns [] on a malformed header.
 */
export function parseXYZPositions(xyz: string): [number, number, number][] {
  const lines = xyz.split("\n");
  const n = parseInt(lines[0] ?? "");
  if (!Number.isFinite(n) || n <= 0) return [];
  const out: [number, number, number][] = [];
  for (let i = 0; i < n && i + 2 < lines.length; i++) {
    const t = (lines[i + 2] ?? "").trim().split(/\s+/);
    out.push([parseFloat(t[1] ?? "0"), parseFloat(t[2] ?? "0"), parseFloat(t[3] ?? "0")]);
  }
  return out;
}

/** First float on an XYZ frame's comment line — by convention the energy
 *  (Eh) in ORCA trajectory/ensemble files. */
export function parseXYZFrameEnergy(frame: string | undefined): number | undefined {
  if (!frame) return undefined;
  const comment = frame.split("\n")[1] ?? "";
  const m = comment.match(/-?\d+\.\d+/);
  if (!m) return undefined;
  return Number(m[0]);
}

/** Parses a concatenated XYZ trajectory into individual single-frame strings. */
export function parseMultiXYZ(text: string): string[] {
  const lines = text.split("\n");
  const frames: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const head = (lines[i] ?? "").trim();
    if (!head) {
      i++;
      continue;
    }
    const n = Number(head);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      i++;
      continue;
    }
    const need = n + 2;
    if (i + need > lines.length) break;
    frames.push(lines.slice(i, i + need).join("\n"));
    i += need;
  }
  return frames;
}
