import { StructureViewer, type OrbitalCube } from "../components/StructureViewer";
import type { Geometry } from "../data/types";
import { downloadText } from "../lib/download";
import { CopyButton, DownloadIcon, Section } from "./runDetailUi";
import type { PartialCharge } from "./runDetailParsers";

/** Left pane of the Structure tab: 3D viewer with orbital isosurfaces and
 *  charges plus per-frame / trajectory download and copy actions. */
export function RunStructureGeometrySection({
  items,
  idx,
  active,
  activeCycle,
  trajectoryXyzs,
  orbitals,
  charges,
  dipole,
  runName,
}: {
  items: Geometry[];
  idx: number;
  active: Geometry;
  activeCycle: number;
  trajectoryXyzs: string[];
  orbitals: OrbitalCube[];
  charges: PartialCharge[] | undefined;
  dipole?: { vec: [number, number, number]; debye: number } | null;
  runName: string;
}) {
  return (
    <Section
      title="Geometry"
      sub={
        <span>
          cycle{" "}
          <span style={{ color: "var(--text)" }}>{activeCycle}</span> · frame{" "}
          {idx + 1} / {items.length}
        </span>
      }
    >
      <div className="card" style={{ padding: 12 }}>
        <StructureViewer
          xyz={active.xyz}
          trajectory={trajectoryXyzs}
          frameIndex={idx}
          orbitals={orbitals}
          charges={charges}
          dipole={dipole}
          exportFileStem={runName}
          frameLabels={items.map((g) => `cycle${g.cycle}`)}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginTop: 6,
            flexWrap: "wrap",
          }}
        >
          <div className="dim" style={{ fontSize: 12 }}>
            Space play/loop · Enter step+wrap · ← / → step · Home / End jump ·
            drag = rotate, scroll = zoom
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button"
              className="dl-btn"
              onClick={() =>
                downloadText(
                  `${runName}.cycle${activeCycle}.xyz`,
                  active.xyz,
                )
              }
              title="Download the currently displayed geometry as .xyz"
            >
              <DownloadIcon />
              <span>this frame</span>
            </button>
            <CopyButton text={active.xyz} title="Copy the currently displayed geometry to clipboard" label="copy" />
            <button type="button"
              className="dl-btn"
              disabled={items.length < 2}
              onClick={() =>
                downloadText(
                  `${runName}.trj.xyz`,
                  items.map((g) => g.xyz).join("\n"),
                )
              }
              title="Download the full opt trajectory as multi-frame .xyz"
            >
              <DownloadIcon />
              <span>trajectory</span>
              <span className="dl-count">{items.length}</span>
            </button>
            {items.length >= 2 && (
              <CopyButton
                text={items.map((g) => g.xyz).join("\n")}
                title="Copy the full opt trajectory to clipboard"
                label="copy trj"
              />
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}
