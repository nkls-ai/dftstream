import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { useChartColors } from "../lib/chartColors";
import { nucleusLabel } from "../lib/nmrSpectrum";

export function RunNMRSpectrumChart({
  spectrum,
  nucleus,
  chartColors,
}: {
  spectrum: { x: number; y: number }[];
  nucleus: string;
  chartColors: ReturnType<typeof useChartColors>;
}) {
  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="nmr-chart-label">
        Simulated <sup>{nucleusLabel(nucleus).mass}</sup>{nucleus} NMR spectrum, δ vs TMS (Lorentzian broadened)
      </div>
      <div style={{ height: 240 }}>
        <ResponsiveContainer>
          <AreaChart data={spectrum} margin={{ top: 12, right: 24, left: 12, bottom: 28 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis
              dataKey="x"
              stroke={chartColors.axis}
              reversed
              tick={{ fontSize: 11 }}
              type="number"
              label={{ value: `δ vs TMS (ppm) — ${nucleusLabel(nucleus).mass}${nucleus}`, position: "bottom", offset: 12, fontSize: 12, fill: chartColors.axis }}
            />
            <YAxis stroke={chartColors.axis} tick={{ fontSize: 11 }} hide />
            <RechartsTooltip
              contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6 }}
              labelFormatter={(v) => `δ = ${Number(v).toFixed(2)} ppm`}
            />
            <Area
              type="monotone"
              dataKey="y"
              stroke={chartColors.line}
              fill={chartColors.line}
              fillOpacity={0.15}
              strokeWidth={2}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
