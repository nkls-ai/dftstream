import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "../lib/chartColors";
import { useSettings } from "../lib/settings";
import { formatKcalTooltipValue } from "./runChemistryFormat";
import { methodFamily, type MethodGroup } from "../lib/benchmarkUtils";

const FAMILY_COLORS: Record<string, { dark: string; light: string }> = {
  dft:  { dark: "#5eead4", light: "#0D9488" },
  hf:   { dark: "#60a5fa", light: "#2563EB" },
  wft:  { dark: "#c084fc", light: "#7C3AED" },
  xtb:  { dark: "#a3e635", light: "#65A30D" },
};

/** Horizontal bar chart of per-method relative energies, colored by method family. */
export function BenchmarkChart({ groups }: { groups: MethodGroup[] }) {
  const [settings] = useSettings();
  const ch = useChartColors();
  const dark = settings.theme === "dark";

  const chartData = groups.map((g) => ({
    name: g.key,
    value: g.relKcal,
    family: methodFamily(g.runs[0]!),
  }));

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ height: Math.max(200, groups.length * 40 + 60) }}>
        <ResponsiveContainer>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 8, right: 24, left: 12, bottom: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={ch.grid} horizontal={false} />
            <XAxis
              type="number"
              stroke={ch.axis}
              tick={{ fontSize: 11, fill: ch.axis }}
              tickFormatter={(v) => v.toFixed(1)}
              label={{
                value: "ΔE (kcal/mol)",
                position: "insideBottom",
                offset: -4,
                fill: ch.axis,
              }}
            />
            <YAxis
              type="category"
              dataKey="name"
              stroke={ch.axis}
              tick={{ fontSize: 11, fill: ch.tooltipText }}
              width={160}
            />
            <Tooltip
              contentStyle={{
                background: ch.tooltipBg,
                border: `1px solid ${ch.grid}`,
                borderRadius: 6,
                fontSize: 12,
                color: ch.tooltipText,
              }}
              formatter={(v) => [formatKcalTooltipValue(v), "ΔE"]}
            />
            <Bar
              dataKey="value"
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
              label={{
                position: "right",
                fontSize: 11,
                fill: ch.tooltipText,
                formatter: (v) => (typeof v === "number" ? v.toFixed(1) : ""),
              }}
            >
              {chartData.map((d) => {
                const fc = FAMILY_COLORS[d.family] ?? FAMILY_COLORS.dft!;
                return <Cell key={d.name} fill={dark ? fc.dark : fc.light} />;
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
