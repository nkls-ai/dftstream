import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import type { Frequency } from "../data/types";
import { useChartColors } from "../lib/chartColors";
import { formatAbsorbanceTooltipValue, formatWavenumberLabel } from "./runChemistryFormat";
import { Section } from "./runDetailUi";

// Broadened frequency spectrum with the imaginary modes marked — shown both
// in the trajectory split and in the no-trajectory layout.
export function FreqSpectrumCard({
  data,
  imagFreqs,
}: {
  data: { x: number; y: number }[];
  imagFreqs: Frequency[];
}) {
  const chartColors = useChartColors();
  return (
    <div className="card" style={{ padding: "12px 8px" }}>
      <ResponsiveContainer width="100%" height={200}>
        {/* top margin leaves room for the imaginary-mode labels, which are
            drawn above the plot area and would otherwise be clipped */}
        <AreaChart data={data} margin={{ top: 22, right: 8, bottom: 20, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
          <XAxis
            dataKey="x"
            type="number"
            domain={[4200, 0]}
            reversed
            tick={{ fill: chartColors.axis, fontSize: 10 }}
            label={{ value: "Wavenumber (cm⁻¹)", position: "insideBottom", offset: -12, fill: chartColors.axis, fontSize: 11 }}
          />
          <YAxis hide />
          {imagFreqs.map((f) => (
            <ReferenceLine
              key={f.idx}
              x={Math.abs(f.wavenumber)}
              stroke="rgb(var(--rose))"
              strokeWidth={2}
              strokeDasharray="4 3"
              label={{
                value: `${f.wavenumber.toFixed(0)}i`,
                position: "top",
                fill: "rgb(var(--rose))",
                fontSize: 11,
                fontWeight: 600,
              }}
            />
          ))}
          <RechartsTooltip
            contentStyle={{
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 12,
            }}
            formatter={(v) => [formatAbsorbanceTooltipValue(v), "Intensity"]}
            labelFormatter={(v) => formatWavenumberLabel(v)}
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke="rgb(var(--accent-rgb, 56 189 248))"
            fill="rgb(var(--accent-rgb, 56 189 248))"
            fillOpacity={0.3}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// The spectrum card wrapped in its titled section; used by both TS tab layouts.
export function TSSpectrumSection({
  data,
  realCount,
  imagFreqs,
}: {
  data: { x: number; y: number }[];
  realCount: number;
  imagFreqs: Frequency[];
}) {
  return (
    <Section title="Frequency spectrum" sub={<span>{realCount} modes · {imagFreqs.length} imaginary</span>}>
      <FreqSpectrumCard data={data} imagFreqs={imagFreqs} />
    </Section>
  );
}
