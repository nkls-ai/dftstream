import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartColors } from "../lib/chartColors";
import type { MECPEnergyRow } from "./mecpData";
import { Section } from "./runDetailUi";
import { useMemo } from "react";
import { useRelEnergyFormat } from "../lib/useEnergyFormat";
import { EMPTY_ENERGY } from "../lib/energyUnits";
import { Y_AXIS_WIDTH, yAxisTitle } from "../lib/chartAxis";

// Relative energies of the two spin-state surfaces per MECP cycle.
export function RunMECPStateChart({
  data,
  selectedCycle,
}: {
  data: MECPEnergyRow[];
  selectedCycle: number | null;
}) {
  const chartColors = useChartColors();
  const rel = useRelEnergyFormat();
  // Rows are built in kcal/mol; the chart shows the user's unit.
  const rows = useMemo(
    () => data.map((r) => ({
      ...r,
      state1: r.state1 == null ? null : rel.fromKcal(r.state1),
      state2: r.state2 == null ? null : rel.fromKcal(r.state2),
    })),
    [data, rel],
  );
  return (
    <Section title="Two-state convergence" sub={<span>relative energies</span>}>
      <div className="card" style={{ padding: "12px 8px", height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 12, right: 24, left: 12, bottom: 28 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis
              dataKey="cycle"
              type="number"
              domain={["dataMin", "dataMax"]}
              stroke={chartColors.axis}
              tick={{ fontSize: 11 }}
              label={{ value: "MECP cycle", position: "insideBottom", offset: -12, fill: chartColors.axis }}
            />
            <YAxis
              stroke={chartColors.axis}
              width={Y_AXIS_WIDTH}
              tick={{ fontSize: 11 }}
              label={yAxisTitle(`ΔE (${rel.label})`, chartColors.axis)}
            />
            <Tooltip
              contentStyle={{
                background: chartColors.tooltipBg,
                border: `1px solid ${chartColors.grid}`,
                borderRadius: 6,
                color: chartColors.tooltipText,
                fontSize: 12,
              }}
              formatter={(v) => (typeof v === "number" ? rel.formatValue(v) : EMPTY_ENERGY)}
            />
            {selectedCycle != null && <ReferenceLine x={selectedCycle} stroke={chartColors.marker} strokeDasharray="4 3" />}
            <Line type="monotone" dataKey="state1" name="Surface 1" stroke={chartColors.hue("teal")} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
            <Line type="monotone" dataKey="state2" name="Surface 2" stroke={chartColors.hue("gold")} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Section>
  );
}
