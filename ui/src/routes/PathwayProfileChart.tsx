import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ProfilePoint } from "../lib/pathwayUtils";
import { useChartColors } from "../lib/chartColors";
import { useSettings } from "../lib/settings";
import { formatKcalTooltipValue } from "./runChemistryFormat";
import { ROLE_COLORS } from "./pathwayRoles";
import { flatTickFormatter, niceAxis, Y_AXIS_WIDTH, yAxisTitle } from "../lib/chartAxis";

/** Interpolated reaction-coordinate energy profile with clickable stationary points. */
export function PathwayProfileChart({
  data,
  onSelectRun,
  basisLabel = "ΔE",
}: {
  data: ProfilePoint[];
  onSelectRun: (id: string | null) => void;
  /** Y-axis quantity: "ΔE", "ΔH" or "ΔG". */
  basisLabel?: string;
}) {
  const [settings] = useSettings();
  const ch = useChartColors();
  const dark = settings.theme === "dark";

  const yAxis = useMemo(() => niceAxis(data.map((p) => p.y)), [data]);
  const stationaryOnly = useMemo(
    () => data.filter((p) => p.isStationary),
    [data],
  );

  return (
    <div style={{ height: 360 }}>
      <ResponsiveContainer>
        <LineChart
          data={data}
          margin={{ top: 36, right: 24, left: 12, bottom: 36 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke={ch.grid} />
          <XAxis
            dataKey="x"
            stroke={ch.axis}
            tick={false}
            label={{
              value: "Reaction coordinate",
              position: "insideBottom",
              offset: -12,
              fill: ch.axis,
            }}
          />
          <YAxis
            stroke={ch.axis}
            tick={{ fontSize: 11 }}
            domain={yAxis?.domain ?? ["auto", "auto"]}
            ticks={yAxis?.ticks}
            width={Y_AXIS_WIDTH}
            tickFormatter={yAxis?.format ?? flatTickFormatter}
            label={yAxisTitle(`${basisLabel} (kcal/mol)`, ch.axis)}
          />
          <Tooltip
            contentStyle={{
              background: ch.tooltipBg,
              border: `1px solid ${ch.grid}`,
              borderRadius: 6,
              fontSize: 12,
              color: ch.tooltipText,
            }}
            formatter={(v) => [formatKcalTooltipValue(v), basisLabel]}
            labelFormatter={() => ""}
          />
          <Line
            type="monotone"
            dataKey="y"
            stroke={ch.line}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          {stationaryOnly.map((pt, i) => {
            const roleColor = ROLE_COLORS[pt.role ?? "reactant"];
            const color = dark ? roleColor?.dark : roleColor?.light;
            // End points anchor their label inward so it is not cut at the
            // plot edge; the TS label sits above its peak, the rest below.
            const anchor = i === 0 ? "start" : i === stationaryOnly.length - 1 ? "end" : "middle";
            return (
              <ReferenceDot
                key={pt.runId ?? `x-${pt.x}`}
                x={pt.x}
                y={pt.y}
                r={7}
                fill={color}
                stroke={ch.tooltipBg}
                strokeWidth={2}
                style={{ cursor: "pointer" }}
                onClick={() => pt.runId && onSelectRun(pt.runId)}
                label={(props: { viewBox?: unknown }) => (
                  <PointLabel
                    viewBox={props.viewBox}
                    name={pt.label ?? ""}
                    value={pt.y.toFixed(1)}
                    above={pt.role === "ts"}
                    anchor={anchor}
                    fill={color}
                  />
                )}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Two-line (name, value) label beside a stationary point's dot. */
function PointLabel({
  viewBox,
  name,
  value,
  above,
  anchor,
  fill,
}: {
  viewBox: unknown;
  name: string;
  value: string;
  above: boolean;
  anchor: "start" | "middle" | "end";
  fill: string | undefined;
}) {
  if (!isBox(viewBox)) return null;
  const x = viewBox.x + (anchor === "start" ? 0 : anchor === "end" ? viewBox.width : viewBox.width / 2);
  const LINE = 12;
  // Above: value sits closest to the dot, name on top. Below: name first.
  const y0 = above ? viewBox.y - 6 - LINE : viewBox.y + viewBox.height + 12;
  return (
    <text x={x} y={y0} textAnchor={anchor} fill={fill} fontSize={10} fontWeight={600}>
      <tspan x={x}>{name}</tspan>
      <tspan x={x} dy={LINE}>{value}</tspan>
    </text>
  );
}

function isBox(v: unknown): v is { x: number; y: number; width: number; height: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    "x" in v && typeof v.x === "number" &&
    "y" in v && typeof v.y === "number" &&
    "width" in v && typeof v.width === "number" &&
    "height" in v && typeof v.height === "number"
  );
}
