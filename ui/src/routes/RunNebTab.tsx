import { useState } from "react";
import { EnergyChart } from "../components/EnergyChart";
import { PlaybackBar } from "../components/PlaybackBar";
import { SkeletonPanel } from "../components/Skeleton";
import { StructureViewer } from "../components/StructureViewer";
import { usePlayback } from "../hooks/usePlayback";
import { HARTREE_TO_KCAL } from "../lib/constants";
import { useNebTabData } from "./nebTabData";
import type { NEBImage, NEBInterpIteration } from "./neb";
import { Headline, HeadlineTile, ResizableSplit, Section } from "./runDetailUi";
import { RunNebImageTable } from "./RunNebImageTable";
import { RunNebPathSection } from "./RunNebPathSection";
import { useRelEnergyFormat } from "../lib/useEnergyFormat";
import { buildImageChartData, buildMepChart, imageRelKcal } from "./nebPath";

type NebPathSel = { kind: "initial" } | { kind: "iter"; i: number } | { kind: "final" };

export function NEBTab({ runId }: { runId: string }) {
  const {
    loading,
    nebSummary,
    interpData,
    images,
    usePathSummary,
    mepChart,
    imageChartData,
    barrierChart,
    tsXyz,
    initialPathFrames,
    interpIterations,
    pathsByIteration,
  } = useNebTabData(runId);

  const [pathSel, setPathSel] = useState<NebPathSel>({ kind: "final" });
  const rel = useRelEnergyFormat();

  // The last MEP_ALL band is the current/final one — the Final chip already
  // covers it, so only earlier bands become iteration chips.
  const iterPaths = pathsByIteration.slice(0, -1);
  // .interp usually carries one extra leading block (the interpolated start),
  // e.g. 21 iteration profiles for 20 bands. Align from the end.
  const interpOffset = interpIterations.length - pathsByIteration.length;
  const interpForPath = (i: number): NEBInterpIteration | undefined =>
    interpOffset >= 0 ? interpIterations[i + interpOffset] : undefined;
  const iterLabel = (i: number) => interpForPath(i)?.iter ?? i + 1;

  let sel: NebPathSel = pathSel;
  if (sel.kind === "iter" && sel.i >= iterPaths.length) sel = { kind: "final" };
  if (sel.kind === "initial" && initialPathFrames.length <= 1) sel = { kind: "final" };
  // Early in a run there is no band yet — fall back to the interpolated guess.
  if (sel.kind === "final" && images.length === 0 && initialPathFrames.length > 1) {
    sel = { kind: "initial" };
  }

  const selFrames =
    sel.kind === "initial"
      ? initialPathFrames
      : sel.kind === "iter"
        ? iterPaths[sel.i] ?? []
        : [];

  const pb = usePlayback(sel.kind === "final" ? images.length : selFrames.length);
  const selectedImage = pb.idx;

  if (loading) {
    return (
      <div className="tab-shell">
        <SkeletonPanel rows={8} height={360} />
      </div>
    );
  }

  if (!nebSummary && !interpData) {
    // Early in a run only the interpolated guess exists — still worth showing.
    if (initialPathFrames.length > 1) {
      return (
        <div className="tab-shell">
          <Section
            title="Initial path"
            sub={<span>interpolated starting guess ({initialPathFrames.length} images, before NEB refinement)</span>}
          >
            <div className="card" style={{ padding: 12 }}>
              <StructureViewer
                xyz={initialPathFrames[pb.idx] ?? ""}
                trajectory={initialPathFrames}
                frameIndex={pb.idx}
              />
              <PlaybackBar pb={pb} label={(i) => `image ${i}`} />
            </div>
          </Section>
        </div>
      );
    }
    return (
      <div className="empty-state">
        No NEB path data found in this run.
      </div>
    );
  }

  const selected = images[selectedImage];
  const maxBarrier = nebSummary?.iterations.length
    ? nebSummary.iterations[nebSummary.iterations.length - 1]!.barrierEh * HARTREE_TO_KCAL
    : null;

  const pathPicker = (initialPathFrames.length > 1 || iterPaths.length > 0) && (
    <div className="neb-path-picker">
      <span className="neb-path-picker-label">Path</span>
      {initialPathFrames.length > 1 && (
        <button
          type="button"
          className={"neb-path-chip" + (sel.kind === "initial" ? " active" : "")}
          onClick={() => setPathSel({ kind: "initial" })}
        >
          initial
        </button>
      )}
      {iterPaths.map((_, i) => (
        <button
          type="button"
          key={i}
          className={"neb-path-chip" + (sel.kind === "iter" && sel.i === i ? " active" : "")}
          onClick={() => setPathSel({ kind: "iter", i })}
          title={`Band after NEB iteration ${iterLabel(i)}`}
        >
          {iterLabel(i)}
        </button>
      ))}
      <button
        type="button"
        className={"neb-path-chip" + (sel.kind === "final" ? " active" : "")}
        onClick={() => setPathSel({ kind: "final" })}
      >
        final
      </button>
    </div>
  );

  // Structure + energy panes for the selected path. The playback index is
  // deliberately shared across paths so image k can be compared as the band
  // evolves.
  let structurePane: React.ReactNode = null;
  let pathPane: React.ReactNode = null;

  if (sel.kind === "final") {
    structurePane = selected?.xyz || tsXyz ? (
      <Section
        title="Structure"
        sub={
          <span>
            image <span style={{ color: "var(--text)" }}>{selected?.index ?? "?"}</span>
            {selected?.index === nebSummary?.tsImageIndex && (
              <span className="neb-ts-badge" style={{ marginLeft: 6 }}>TS</span>
            )}
            {" · "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {rel.formatKcal(selected ? imageRelKcal(selected, usePathSummary) : null)}
            </span>{" "}
            <span style={{ color: "var(--text-faint)" }}>{rel.label}</span>
            {selected ? ` · ${selected.distance.toFixed(3)} Å` : ""}
          </span>
        }
      >
        <div className="card" style={{ padding: 12 }}>
          <StructureViewer xyz={selected?.xyz ?? tsXyz ?? ""} />
        </div>
      </Section>
    ) : null;
    pathPane = mepChart.length > 0 ? (
      <RunNebPathSection
        mepChart={mepChart}
        imageChartData={imageChartData}
        images={images}
        pb={pb}
        tsImageIndex={nebSummary?.tsImageIndex}
        usePathSummary={usePathSummary}
      />
    ) : null;
  } else if (sel.kind === "iter") {
    const iterInterp = interpForPath(sel.i);
    const iterImages: NEBImage[] = (iterInterp?.images ?? []).map((img, k) => ({
      ...img,
      xyz: selFrames[k],
    }));
    structurePane = selFrames.length > 0 ? (
      <Section
        title="Structure"
        sub={
          <span>
            iteration {iterLabel(sel.i)} · image{" "}
            <span style={{ color: "var(--text)" }}>{pb.idx}</span>
            {iterImages[pb.idx] && (
              <>
                {" · "}
                <span className="mono" style={{ color: "var(--text)" }}>
                  {rel.format(iterImages[pb.idx]!.energy)}
                </span>{" "}
                <span style={{ color: "var(--text-faint)" }}>{rel.label}</span>
              </>
            )}
          </span>
        }
      >
        <div className="card" style={{ padding: 12 }}>
          <StructureViewer
            xyz={selFrames[pb.idx] ?? ""}
            trajectory={selFrames}
            frameIndex={pb.idx}
          />
          <PlaybackBar pb={pb} label={(i) => `image ${i}`} />
        </div>
      </Section>
    ) : null;
    pathPane = iterInterp ? (
      <RunNebPathSection
        mepChart={buildMepChart(iterInterp.interp, [], false)}
        imageChartData={buildImageChartData(iterInterp.images, false)}
        images={iterImages}
        pb={pb}
        tsImageIndex={undefined}
        usePathSummary={false}
      />
    ) : null;
  } else {
    structurePane = (
      <Section
        title="Initial path"
        sub={
          <span>
            interpolated starting guess ({initialPathFrames.length} images)
            {" · "}image <span style={{ color: "var(--text)" }}>{pb.idx}</span>
          </span>
        }
      >
        <div className="card" style={{ padding: 12 }}>
          <StructureViewer
            xyz={initialPathFrames[pb.idx] ?? ""}
            trajectory={initialPathFrames}
            frameIndex={pb.idx}
          />
          <PlaybackBar pb={pb} label={(i) => `image ${i}`} />
        </div>
      </Section>
    );
  }

  return (
    <div className="tab-shell">
      <Headline>
        <HeadlineTile label="Images" value={images.length || "?"} />
        {iterPaths.length > 0 && (
          <HeadlineTile label="Paths" value={iterPaths.length + 1} sub="live · switch below" />
        )}
        {maxBarrier != null && (
          <HeadlineTile label="Barrier" value={rel.formatKcal(maxBarrier)} unit={rel.label} />
        )}
        {nebSummary?.converged && (
          <HeadlineTile label="Status" value="Converged" />
        )}
        {nebSummary?.tsImageIndex != null && (
          <HeadlineTile label="TS image" value={`#${nebSummary.tsImageIndex}`} />
        )}
      </Headline>

      {pathPicker}

      {pathPane && structurePane ? (
        <ResizableSplit defaultLeftPct={67} left={structurePane} right={pathPane} />
      ) : (
        pathPane ?? structurePane
      )}

      {barrierChart.length > 1 && (
        <Section title="Barrier convergence" sub="barrier height per NEB iteration">
          <EnergyChart
            data={rel.seriesFromKcal(barrierChart)}
            formatValue={rel.formatValue}
            xLabel="NEB iteration"
            yLabel={`Barrier (${rel.label})`}
            height={220}
          />
        </Section>
      )}

      {images.length > 0 && (
        <RunNebImageTable
          images={images}
          selectedImage={sel.kind === "final" ? selectedImage : -1}
          tsImageIndex={nebSummary?.tsImageIndex}
          usePathSummary={usePathSummary}
          onSelect={(i) => {
            setPathSel({ kind: "final" });
            pb.setIdx(i);
          }}
        />
      )}
    </div>
  );
}
