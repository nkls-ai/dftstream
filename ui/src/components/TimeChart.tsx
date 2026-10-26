import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors, type Hue } from "../lib/chartColors";
import { flatTickFormatter, niceAxis, Y_AXIS_WIDTH, yAxisTitle } from "../lib/chartAxis";

interface Props {
  data: { ts: number; value: number }[];
  yLabel: string;
  /** Series accent, resolved for the active theme. */
  hue?: Hue;
  unit?: string;
  height?: number;
  startTs?: number; // optional t0; x-axis shows seconds since this
}

// TimeChart renders a single time series. X-axis shows seconds since
// `startTs` (default: the first sample's ts) so durations are obvious.
export function TimeChart({
  data,
  yLabel,
  hue = "blue",
  unit = "",
  height = 220,
  startTs,
}: Props) {
  const ch = useChartColors();
  const color = ch.hue(hue);
  if (!data.length) {
    return <div className="empty-state">No samples yet.</div>;
  }
  const t0 = startTs ?? data[0]!.ts;
  const points = data.map((d) => ({ x: (d.ts - t0) / 1000, y: d.value }));
  const maxX = points[points.length - 1]?.x ?? 0;
  const tickFmt = pickTimeFormatter(maxX);
  const yAxis = niceAxis(points.map((p) => p.y));
  return (
    <div style={{ height }}>
      <ResponsiveContainer>
        <LineChart data={points} margin={{ top: 12, right: 24, left: 12, bottom: 28 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={ch.grid} />
          <XAxis
            dataKey="x"
            type="number"
            domain={["dataMin", "dataMax"]}
            stroke={ch.axis}
            tickFormatter={tickFmt}
            label={{ value: "elapsed", position: "insideBottom", offset: -12, fill: ch.axis }}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            stroke={ch.axis}
            domain={yAxis?.domain ?? ["auto", "auto"]}
            ticks={yAxis?.ticks}
            width={Y_AXIS_WIDTH}
            tickFormatter={yAxis?.format ?? flatTickFormatter}
            tick={{ fontSize: 11 }}
            label={yAxisTitle(yLabel, ch.axis)}
          />
          <Tooltip
            contentStyle={{
              background: ch.tooltipBg,
              border: `1px solid ${ch.grid}`,
              borderRadius: 6,
              fontSize: 12,
              color: ch.tooltipText,
            }}
            labelFormatter={(v) => `t = ${formatElapsed(Number(v))}`}
            formatter={(v) =>
              typeof v === "number" ? `${v.toFixed(2)}${unit ? " " + unit : ""}` : "-"
            }
          />
          <Line
            type="monotone"
            dataKey="y"
            stroke={color}
            strokeWidth={2}
            dot={{ r: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// pickTimeFormatter returns a tick formatter for "elapsed since start"
// that adapts to the magnitude of the range:
//   <1s   → "200ms"
//   <60s  → "12.4s" (1 decimal, so adjacent ticks aren't both "0s")
//   <1h   → "3m12s"
//   else  → "1h05m"
function pickTimeFormatter(maxX: number): (v: number) => string {
  if (maxX < 1) {
    return (v) => `${Math.round(v * 1000)}ms`;
  }
  if (maxX < 60) {
    return (v) => `${v.toFixed(1)}s`;
  }
  if (maxX < 3600) {
    return (v) => {
      const m = Math.floor(v / 60);
      const s = Math.floor(v % 60);
      return `${m}m${s.toString().padStart(2, "0")}s`;
    };
  }
  return (v) => {
    const h = Math.floor(v / 3600);
    const m = Math.floor((v % 3600) / 60);
    return `${h}h${m.toString().padStart(2, "0")}m`;
  };
}

function formatElapsed(v: number): string {
  if (v < 1) return `${Math.round(v * 1000)} ms`;
  if (v < 60) return `${v.toFixed(2)} s`;
  if (v < 3600) {
    const m = Math.floor(v / 60);
    const s = (v % 60).toFixed(1);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(v / 3600);
  const m = Math.floor((v % 3600) / 60);
  const s = Math.floor(v % 60);
  return `${h}h ${m}m ${s}s`;
}
