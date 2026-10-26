import { EnergyChart } from "../components/EnergyChart";
import { PlaybackBar } from "../components/PlaybackBar";
import type { Playback } from "../hooks/usePlayback";
import type { NEBImage } from "./neb";
import { closestImageIndex, type ChartPoint } from "./nebPath";
import { Section } from "./runDetailUi";
import { useMemo } from "react";
import { useRelEnergyFormat } from "../lib/useEnergyFormat";

// The minimum-energy-path chart with per-image dot buttons and playback.
export function RunNebPathSection({
  mepChart,
  imageChartData,
  images,
  pb,
  tsImageIndex,
  usePathSummary,
}: {
  mepChart: ChartPoint[];
  imageChartData: ChartPoint[];
  images: NEBImage[];
  pb: Playback;
  tsImageIndex: number | null | undefined;
  usePathSummary: boolean;
}) {
  const rel = useRelEnergyFormat();
  const selectedImage = pb.idx;
  const selected = images[selectedImage];
  // Series arrive in kcal/mol; the chart shows the user's unit.
  const mepDisplay = useMemo(() => rel.seriesFromKcal(mepChart), [rel, mepChart]);
  return (
    <Section title="Minimum energy path" sub="click on the curve to inspect an image">
      <div style={{ position: "relative" }}>
        <EnergyChart
          data={mepDisplay}
          formatValue={rel.formatValue}
          xLabel={usePathSummary ? "Reaction coordinate (Å)" : "Reaction coordinate (Bohr)"}
          yLabel={`ΔE (${rel.label})`}
          height={320}
          markerX={selected ? selected.distance : null}
          markerLabel={selected ? `image ${selectedImage}` : undefined}
          onClickPoint={(i) => {
            if (!images.length) return;
            const clickDist = mepChart[i]?.x ?? 0;
            pb.setIdx(closestImageIndex(images, clickDist));
          }}
        />
        {imageChartData.length > 0 && (
          <div className="neb-image-dots">
            {imageChartData.map((d, i) => (
              <button type="button"
                key={images[i]?.index ?? i}
                className={"neb-dot" + (i === selectedImage ? " active" : "") + (i === tsImageIndex ? " ts" : "")}
                onClick={() => pb.setIdx(i)}
                title={`Image ${i}: ${rel.formatKcal(d.y)} ${rel.label}`}
              >
                {i}
              </button>
            ))}
          </div>
        )}
        {images.length > 1 && (
          <PlaybackBar
            pb={pb}
            label={(i, n) => `${i === 0 ? "R" : i === n - 1 ? "P" : `img ${images[i]?.index ?? i}`} · ${i + 1} / ${n}`}
          />
        )}
      </div>
    </Section>
  );
}
