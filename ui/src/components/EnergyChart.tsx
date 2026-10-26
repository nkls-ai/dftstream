import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors, type Hue } from "../lib/chartColors";
import { useEhFormatter } from "../lib/useEnergyFormat";
import { EMPTY_ENERGY } from "../lib/energyUnits";
import { flatTickFormatter, niceAxis, Y_AXIS_WIDTH, yAxisTitle } from "../lib/chartAxis";

export interface ChartAnnotation {
  x: number;
  y: number;
  label: string;
  /** Theme-resolved accent (lib/palette.ts). */
  hue: Hue;
}

interface Props {
  data: { x: number; y: number }[];
  xLabel?: string;
  yLabel?: string;
  height?: number;
  markerX?: number | null;
  /** Text above the marker line; defaults to "cycle <markerX>". */
  markerLabel?: string;
  onClickPoint?: (index: number) => void;
  annotations?: ChartAnnotation[];
  /** Tooltip value format; defaults to absolute Eh at the user's precision. */
  formatValue?: (v: number) => string;
}

export function EnergyChart({
  data,
  xLabel = "cycle",
  yLabel = "Energy (Eh)",
  height = 320,
  markerX = null,
  markerLabel,
  onClickPoint,
  annotations,
  formatValue,
}: Props) {
  const c = useChartColors();
  const fmtEh = useEhFormatter();
  const fmt = formatValue ?? fmtEh;
  const yAxis = niceAxis(data.map((d) => d.y));
  // Marker and annotation labels sit above their point; give them headroom
  // so a label on the top-most point (IRC TS, NEB climbing image) is not cut.
  const labelled = markerX != null || (annotations?.length ?? 0) > 0;
  const margin = { top: labelled ? 28 : 12, right: 24, left: 12, bottom: 28 };
  const handleClick = (event: unknown) => {
    if (!onClickPoint || !isTooltipEvent(event)) return;
    onClickPoint(event.activeTooltipIndex);
  };

  if (!data.length) {
    return <div className="empty-state">No energy points yet.</div>;
  }
  return (
    <div style={{ height }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={margin} onClick={onClickPoint ? handleClick : undefined} style={onClickPoint ? { cursor: "pointer" } : undefined}>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="x"
            type="number"
            domain={["dataMin", "dataMax"]}
            // Iteration / cycle axes are integers: no "1.5" ticks.
            allowDecimals={!data.every((d) => Number.isInteger(d.x))}
            stroke={c.axis}
            label={{ value: xLabel, position: "insideBottom", offset: -12, fill: c.axis }}
            tick={{ fontSize: 11 }}
          />
          <YAxis
            stroke={c.axis}
            domain={yAxis?.domain ?? ["auto", "auto"]}
            ticks={yAxis?.ticks}
            width={Y_AXIS_WIDTH}
            tickFormatter={yAxis?.format ?? flatTickFormatter}
            tick={{ fontSize: 11 }}
            label={yAxisTitle(yLabel, c.axis)}
          />
          <Tooltip
            contentStyle={{
              background: c.tooltipBg,
              border: `1px solid ${c.grid}`,
              borderRadius: 6,
              fontSize: 12,
              color: c.tooltipText,
            }}
            formatter={(v) => (typeof v === "number" ? fmt(v) : EMPTY_ENERGY)}
          />
          {markerX != null && (
            <ReferenceLine
              x={markerX}
              stroke={c.marker}
              strokeWidth={2}
              strokeDasharray="4 3"
              label={{
                value: markerLabel ?? `cycle ${markerX}`,
                position: "top",
                fill: c.marker,
                fontSize: 10,
              }}
            />
          )}
          <Line
            type="monotone"
            dataKey="y"
            stroke={c.line}
            strokeWidth={2}
            dot={{ r: 3, fill: c.line }}
            isAnimationActive={false}
          />
          {annotations?.map((a) => (
            <ReferenceDot
              key={`${a.x}-${a.label}`}
              x={a.x}
              y={a.y}
              r={6}
              fill={c.hue(a.hue)}
              stroke={c.tooltipBg}
              strokeWidth={2}
              label={{ value: a.label, position: "top", fill: c.hue(a.hue), fontSize: 10, fontWeight: 600 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function isTooltipEvent(event: unknown): event is { activeTooltipIndex: number } {
  return (
    typeof event === "object" &&
    event !== null &&
    "activeTooltipIndex" in event &&
    typeof event.activeTooltipIndex === "number"
  );
}
