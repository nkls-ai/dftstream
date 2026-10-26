import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useDataSource } from "../data/DataSource";
import { useChartColors } from "../lib/chartColors";
import { computeUVVisSpectrum, parseTransitions } from "../lib/uvVisSpectrum";
import { Section } from "./runDetailUi";
import { Y_AXIS_WIDTH, yAxisTitle } from "../lib/chartAxis";

export function ExcitedStatesTab({ runId }: { runId: string }) {
  const ds = useDataSource();
  const states = ds.useRunExcitedStates(runId);
  const chartColors = useChartColors();

  const data = useMemo(() => states.data ?? [], [states.data]);
  const spectrum = useMemo(
    () => computeUVVisSpectrum(data, { xMin: 150, xMax: 700 }),
    [data],
  );

  if (states.loading) {
    return <div className="tab-shell"><div className="empty-state">Loading excited states…</div></div>;
  }
  if (data.length === 0) {
    return <div className="tab-shell"><div className="empty-state">No excited states data available.</div></div>;
  }

  const activeStates = data.filter((s) => s.oscStrength > 0);

  return (
    <div className="tab-shell">
      <Section title="UV-Vis Absorption Spectrum" sub={<span>Gaussian broadened · {data.length} states</span>}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ height: 300 }}>
            <ResponsiveContainer>
              <AreaChart data={spectrum} margin={{ top: 12, right: 24, left: 12, bottom: 28 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis
                  dataKey="x"
                  stroke={chartColors.axis}
                  tick={{ fontSize: 11 }}
                  type="number"
                  domain={[150, 700]}
                  label={{ value: "Wavelength (nm)", position: "bottom", offset: 12, fontSize: 12, fill: chartColors.axis }}
                />
                <YAxis
                  stroke={chartColors.axis}
                  width={Y_AXIS_WIDTH}
                  tick={{ fontSize: 11 }}
                  label={yAxisTitle("Oscillator Strength", chartColors.axis)}
                />
                <RechartsTooltip
                  contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 6 }}
                  labelFormatter={(v) => `${Number(v).toFixed(0)} nm`}
                  formatter={(v) => [Number(v).toFixed(4), "Abs"]}
                />
                <Area
                  type="monotone"
                  dataKey="y"
                  stroke={chartColors.line}
                  fill={chartColors.line}
                  fillOpacity={0.2}
                  strokeWidth={2}
                  dot={false}
                />
                {activeStates.map((s) => (
                  <ReferenceLine
                    key={s.idx}
                    x={s.wavelengthNm}
                    stroke={chartColors.line}
                    strokeDasharray="3 3"
                    strokeOpacity={0.6}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-legend">
            <span className="chart-legend-item">
              <span className="chart-legend-line" style={{ background: chartColors.line }} />
              Broadened envelope
            </span>
            <span className="chart-legend-item">
              <span className="chart-legend-dash" style={{ borderColor: chartColors.line }} />
              Individual state positions (stick spectrum)
            </span>
          </div>
        </div>
      </Section>

      <Section title="Excited States" sub={<span>{data.length} states computed</span>}>
        <div className="card" style={{ padding: 0 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>State</th>
                <th>Energy (eV)</th>
                <th>λ (nm)</th>
                <th>f (osc)</th>
                <th>Dominant Transitions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => {
                const trans = parseTransitions(s.transitions);
                return (
                  <tr key={s.idx} className={s.oscStrength > 0.01 ? "row-highlight" : ""}>
                    <td className="mono">{s.idx}</td>
                    <td className="mono">{s.energyEv.toFixed(3)}</td>
                    <td className="mono">{s.wavelengthNm.toFixed(1)}</td>
                    <td className="mono">{s.oscStrength.toFixed(6)}</td>
                    <td className="mono dim">
                      {trans.length > 0
                        ? trans.slice(0, 3).map((t) => `${t.from}→${t.to} ${t.pct}%`).join(", ")
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
