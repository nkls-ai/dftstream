import type { BondOrder, PartialCharge } from "./runDetailParsers";
import { atomTileColors, bondOrderBar } from "./runStructureData";

/** One atom in the partial-charge grid, tinted by its charge (blue − /
 *  pink +, intensity by magnitude). */
export function AtomTile({ c }: { c: PartialCharge }) {
  const { bg, border } = atomTileColors(c.charge);
  return (
    <div
      className="atom-tile"
      style={{ background: bg, borderColor: border }}
      title={`${c.element}${c.idx}: ${c.charge.toFixed(4)} e`}
    >
      <span className="atom-tile-idx">{c.idx}</span>
      <span className="atom-tile-el">{c.element}</span>
      <span className="atom-tile-q">
        {c.charge >= 0 ? "+" : ""}
        {c.charge.toFixed(3)}
      </span>
    </div>
  );
}

/** One Mayer bond order as a labeled proportional bar. */
export function BondOrderRow({ bond }: { bond: BondOrder }) {
  const { barWidth, isStrong } = bondOrderBar(bond.order);
  return (
    <div className="bo-row">
      <span className="bo-atoms">
        {bond.elemA}{bond.atomA}–{bond.elemB}{bond.atomB}
      </span>
      <span className="bo-bar-wrap">
        <span
          className="bo-bar"
          style={{
            width: barWidth,
            background: isStrong
              ? "rgba(var(--teal), 0.55)"
              : "rgba(var(--blue), 0.35)",
          }}
        />
      </span>
      <span className="bo-val">{bond.order.toFixed(4)}</span>
    </div>
  );
}
