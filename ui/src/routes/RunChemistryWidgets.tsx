import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from "recharts";
import { computeIRSpectrum } from "../lib/irSpectrum";
import { useChartColors } from "../lib/chartColors";
import { Section, StatGrid, StatRow } from "./runDetailUi";
import type { Thermo } from "./runDetailParsers";
import {
  formatAbsorbanceTooltipValue,
  formatWavenumberLabel,
} from "./runChemistryFormat";
import { Y_AXIS_WIDTH, yAxisTitle } from "../lib/chartAxis";

/** One thermochemistry stat row: Eh value + optional kcal/mol conversion. */
function ThermoRow({
  k,
  eh,
  kcal,
  decimals,
}: {
  k: string;
  eh: number | null;
  kcal?: number | null;
  decimals: number;
}) {
  if (eh == null) return null;
  return (
    <StatRow
      k={k}
      v={eh.toFixed(decimals)}
      unit="Eh"
      conv={kcal != null ? `${kcal.toFixed(2)} kcal/mol` : undefined}
    />
  );
}

/** Small dim group label between thermochemistry stat rows. */
function ThermoGroupLabel({ children }: { children: string }) {
  return (
    <div className="dim" style={{ gridColumn: "1 / -1", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginTop: 10, marginBottom: 2 }}>
      {children}
    </div>
  );
}

/** "298.15 K, 1 atm" from the parsed section, falling back to ORCA's
 *  defaults when the client-side parse hasn't landed (record-only data). */
function thermoConditions(thermo: Thermo): string {
  const t = thermo.temperatureK != null ? `${thermo.temperatureK} K` : "298.15 K";
  const p = thermo.pressureAtm != null ? `${thermo.pressureAtm} atm` : "1 atm";
  const q = thermo.quasiRRHO ? " · quasi-RRHO" : "";
  return `${t}, ${p}${q}`;
}

export function ThermoBlock({
  thermo,
  decimals,
  simple,
}: {
  thermo: Thermo;
  decimals: number;
  simple: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const ed = decimals;
  const sub = thermoConditions(thermo);

  if (simple && !expanded) {
    return (
      <Section title="Thermochemistry" sub={sub}>
        <StatGrid>
          <ThermoRow k="G − E(el)" eh={thermo.gMinusEEh} kcal={thermo.gMinusEKcal} decimals={ed} />
          {thermo.gMinusEEh == null && (
            <ThermoRow k="Gibbs G" eh={thermo.gibbsEh} decimals={ed} />
          )}
        </StatGrid>
        <button
          className="expand-toggle dim"
          onClick={() => setExpanded(true)}
          type="button"
        >
          Show full thermochemistry
        </button>
      </Section>
    );
  }

  const hasInnerTerms =
    thermo.thermalVibCorrEh != null ||
    thermo.thermalRotCorrEh != null ||
    thermo.thermalTransCorrEh != null;
  const hasEntropyTerms =
    thermo.electronicEntropyEh != null ||
    thermo.vibEntropyEh != null ||
    thermo.rotEntropyEh != null ||
    thermo.transEntropyEh != null;

  return (
    <Section title="Thermochemistry" sub={sub}>
      <StatGrid>
        <ThermoRow k="E(el)" eh={thermo.electronicEh} decimals={ed} />
        <ThermoRow k="ZPE" eh={thermo.zpeEh} kcal={thermo.zpeKcal} decimals={ed} />
        {hasInnerTerms && (
          <>
            <ThermoGroupLabel>Thermal corrections (U)</ThermoGroupLabel>
            <ThermoRow k="Vibrational" eh={thermo.thermalVibCorrEh} kcal={thermo.thermalVibCorrKcal} decimals={ed} />
            <ThermoRow k="Rotational" eh={thermo.thermalRotCorrEh} kcal={thermo.thermalRotCorrKcal} decimals={ed} />
            <ThermoRow k="Translational" eh={thermo.thermalTransCorrEh} kcal={thermo.thermalTransCorrKcal} decimals={ed} />
          </>
        )}
        <ThermoRow k="Inner U" eh={thermo.innerEh} decimals={ed} />
        <ThermoRow k="H corr. (kB·T)" eh={thermo.enthalpyCorrEh} kcal={thermo.enthalpyCorrKcal} decimals={ed} />
        <ThermoRow k="Enthalpy H" eh={thermo.enthalpyEh} decimals={ed} />
        {hasEntropyTerms && (
          <>
            <ThermoGroupLabel>Entropy terms (T·S)</ThermoGroupLabel>
            <ThermoRow k="Electronic" eh={thermo.electronicEntropyEh} decimals={ed} />
            <ThermoRow k="Vibrational" eh={thermo.vibEntropyEh} decimals={ed} />
            <ThermoRow k="Rotational" eh={thermo.rotEntropyEh} decimals={ed} />
            <ThermoRow k="Translational" eh={thermo.transEntropyEh} decimals={ed} />
            <ThermoRow k="T·S total" eh={thermo.finalEntropyTermEh} kcal={thermo.finalEntropyTermKcal} decimals={ed} />
          </>
        )}
        <ThermoRow k="−T·S (G corr.)" eh={thermo.entropyEh} kcal={thermo.entropyKcal} decimals={ed} />
        <ThermoRow k="Gibbs G" eh={thermo.gibbsEh} decimals={ed} />
        <ThermoRow k="G − E(el)" eh={thermo.gMinusEEh} kcal={thermo.gMinusEKcal} decimals={ed} />
        {(thermo.totalThermalCorrEh != null || thermo.totalCorrEh != null) && (
          <>
            <ThermoGroupLabel>Corrections to E(el)</ThermoGroupLabel>
            <ThermoRow k="Thermal" eh={thermo.totalThermalCorrEh} kcal={thermo.totalThermalCorrKcal} decimals={ed} />
            <ThermoRow k="ZPE (non-thermal)" eh={thermo.zpeEh} kcal={thermo.zpeKcal} decimals={ed} />
            <ThermoRow k="Total corr." eh={thermo.totalCorrEh} kcal={thermo.totalCorrKcal} decimals={ed} />
          </>
        )}
      </StatGrid>
      {simple && (
        <button
          className="expand-toggle dim"
          onClick={() => setExpanded(false)}
          type="button"
        >
          Collapse
        </button>
      )}
    </Section>
  );
}


export function IRSpectrumChart({ freqs, scaleFactor }: { freqs: { wavenumber: number; irIntensity?: number }[]; scaleFactor?: number }) {
  const c = useChartColors();
  const data = useMemo(() => {
    const active = freqs.filter(
      (f): f is { wavenumber: number; irIntensity: number } =>
        f.irIntensity != null && f.irIntensity > 0 && f.wavenumber > 0,
    );
    return computeIRSpectrum(active, { scaleFactor });
  }, [freqs, scaleFactor]);

  if (data.length === 0) return null;

  return (
    <div style={{ height: 280 }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 12, right: 24, left: 12, bottom: 28 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={c.grid} />
          <XAxis
            dataKey="x"
            stroke={c.axis}
            reversed
            tick={{ fontSize: 11 }}
            type="number"
            domain={["dataMin", "dataMax"]}
            label={{ value: "Wavenumber (cm⁻¹)", position: "insideBottom", offset: -12, fill: c.axis }}
          />
          <YAxis
            stroke={c.axis}
            tick={{ fontSize: 11 }}
            width={Y_AXIS_WIDTH}
            tickFormatter={(v) => v.toFixed(0)}
            label={yAxisTitle("Absorbance (a.u.)", c.axis)}
          />
          <RechartsTooltip
            contentStyle={{
              background: c.tooltipBg,
              border: `1px solid ${c.grid}`,
              borderRadius: 6,
              fontSize: 12,
              color: c.tooltipText,
            }}
            formatter={(v) => [formatAbsorbanceTooltipValue(v), "Absorbance"]}
            labelFormatter={(v) => formatWavenumberLabel(v)}
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke={c.line}
            fill={c.line}
            fillOpacity={0.15}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
