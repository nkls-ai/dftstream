import { useMemo } from "react";
import { HARTREE_TO_EV } from "../lib/constants";
import type { OrbitalLevel } from "./runDetailParsers";

// How many levels to draw on each side of the gap. The full table can be
// thousands of virtuals; the chemistry lives around the frontier.
const OCC_SHOWN = 10;
const VIRT_SHOWN = 10;
// Levels closer than this (Eh) are drawn side by side as one degenerate set.
const DEGENERACY_EH = 0.002;

interface LevelGroup {
  ev: number;
  levels: OrbitalLevel[];
  occupied: boolean;
}

export function buildLevelGroups(levels: OrbitalLevel[]): {
  groups: LevelGroup[];
  homoMO: number | null;
  lumoMO: number | null;
} {
  let homoIdx = -1;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i]!.occ > 0) homoIdx = i;
    else break;
  }
  const start = Math.max(0, homoIdx - (OCC_SHOWN - 1));
  const end = Math.min(levels.length, homoIdx + 1 + VIRT_SHOWN);
  const window = levels.slice(start, end);

  const groups: LevelGroup[] = [];
  for (const lvl of window) {
    const last = groups[groups.length - 1];
    const occupied = lvl.occ > 0;
    if (
      last &&
      last.occupied === occupied &&
      Math.abs(last.levels[last.levels.length - 1]!.eh - lvl.eh) < DEGENERACY_EH
    ) {
      last.levels.push(lvl);
    } else {
      groups.push({ ev: lvl.ev, levels: [lvl], occupied });
    }
  }
  return {
    groups,
    homoMO: homoIdx >= 0 ? levels[homoIdx]!.idx : null,
    lumoMO: homoIdx >= 0 && homoIdx + 1 < levels.length ? levels[homoIdx + 1]!.idx : null,
  };
}

/**
 * MO energy-level diagram: the classic ladder around the frontier
 * orbitals. Occupied levels solid, virtual dashed, degenerate levels side
 * by side, HOMO/LUMO annotated. Hover a level for MO index + energy.
 */
export function MODiagram({ levels }: { levels: OrbitalLevel[] }) {
  const { groups, homoMO, lumoMO } = useMemo(() => buildLevelGroups(levels), [levels]);
  if (groups.length === 0) return null;

  const W = 250;
  const H = 300;
  const PAD_Y = 18;
  const LADDER_X0 = 24;
  const LADDER_X1 = 168;
  const evs = groups.map((g) => g.ev);
  const minEv = Math.min(...evs);
  const maxEv = Math.max(...evs);
  const span = maxEv - minEv || 1;
  const y = (ev: number) => H - PAD_Y - ((ev - minEv) / span) * (H - 2 * PAD_Y);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", maxWidth: 320, display: "block" }}
      role="img"
      aria-label="Molecular orbital energy level diagram"
    >
      {/* energy axis */}
      <line x1={12} y1={PAD_Y - 6} x2={12} y2={H - PAD_Y + 6} stroke="var(--border)" strokeWidth={1} />
      <text x={4} y={12} fontSize={9} fill="var(--text-faint)">
        eV
      </text>
      {groups.map((g) => {
        const n = g.levels.length;
        const totalW = LADDER_X1 - LADDER_X0;
        const segW = Math.min(totalW / n - (n > 1 ? 4 : 0), 64);
        const groupW = n * segW + (n - 1) * 4;
        const x0 = LADDER_X0 + (totalW - groupW) / 2;
        const gy = y(g.ev);
        const isHomo = g.levels.some((l) => l.idx === homoMO);
        const isLumo = g.levels.some((l) => l.idx === lumoMO);
        const stroke = g.occupied ? "rgb(var(--teal))" : "rgb(var(--gold))";
        return (
          <g key={g.levels[0]!.idx}>
            {g.levels.map((l, i) => (
              <line
                key={l.idx}
                x1={x0 + i * (segW + 4)}
                x2={x0 + i * (segW + 4) + segW}
                y1={gy}
                y2={gy}
                stroke={stroke}
                strokeWidth={isHomo || isLumo ? 2.5 : 1.5}
                strokeDasharray={g.occupied ? undefined : "4 3"}
              >
                <title>
                  {`MO ${l.idx} · ${l.eh.toFixed(5)} Eh (${l.ev.toFixed(3)} eV) · occ ${l.occ}`}
                </title>
              </line>
            ))}
            {(isHomo || isLumo) && (
              <text
                x={LADDER_X1 + 8}
                y={gy + 3}
                fontSize={10}
                fontWeight={600}
                fill={stroke}
              >
                {isHomo ? "HOMO" : "LUMO"} {g.ev.toFixed(2)} eV
              </text>
            )}
          </g>
        );
      })}
      {/* gap bracket between HOMO and LUMO */}
      {homoMO != null && lumoMO != null && (() => {
        const homoG = groups.find((g) => g.levels.some((l) => l.idx === homoMO));
        const lumoG = groups.find((g) => g.levels.some((l) => l.idx === lumoMO));
        if (!homoG || !lumoG) return null;
        const gapEv = lumoG.ev - homoG.ev;
        const midY = (y(homoG.ev) + y(lumoG.ev)) / 2;
        return (
          <text x={LADDER_X1 + 8} y={midY + 3} fontSize={9} fill="var(--text-muted)">
            Δ {gapEv.toFixed(2)} eV ({(gapEv / HARTREE_TO_EV).toFixed(4)} Eh)
          </text>
        );
      })()}
    </svg>
  );
}
