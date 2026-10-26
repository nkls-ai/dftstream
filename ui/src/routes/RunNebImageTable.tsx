import type { NEBImage } from "./neb";
import { Section } from "./runDetailUi";
import { useRelEnergyFormat } from "../lib/useEnergyFormat";
import { imageRelKcal } from "./nebPath";

// Per-image table for the NEB path: distance, relative energy, and the
// reactant/product/TS role of each image.
export function RunNebImageTable({
  images,
  selectedImage,
  tsImageIndex,
  usePathSummary,
  onSelect,
}: {
  images: NEBImage[];
  selectedImage: number;
  tsImageIndex: number | null | undefined;
  usePathSummary: boolean;
  onSelect: (idx: number) => void;
}) {
  const rel = useRelEnergyFormat();
  return (
    <Section title="Image details" sub="click a row or the chart">
      <div className="scan-table-wrap sticky-head">
        <table className="table scan-table">
          <thead>
            <tr>
              <th>Image</th>
              <th>Distance (Å)</th>
              <th>ΔE ({rel.label})</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {images.map((img, i) => (
              <tr
                key={img.index}
                className={
                  (i === selectedImage ? "scan-row-selected" : "") +
                  (i === tsImageIndex ? " neb-ts-row" : "")
                }
                onClick={() => onSelect(i)}
              >
                <td className="mono">{img.index}</td>
                <td className="mono">{img.distance.toFixed(4)}</td>
                <td className="mono">{rel.formatKcal(imageRelKcal(img, usePathSummary))}</td>
                <td>{i === tsImageIndex ? <span className="neb-ts-badge">TS</span> : i === 0 ? "Reactant" : i === images.length - 1 ? "Product" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
