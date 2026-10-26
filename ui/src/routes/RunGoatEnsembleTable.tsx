import { useState } from "react";
import { SortableTh } from "../components/SortableTh";
import { useTableSort } from "../hooks/useTableSort";
import { downloadText } from "../lib/download";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { readMapEntry, writeMapEntry } from "../lib/persistedMap";
import { goatEnsembleCSV, type GoatConformer } from "./goat";
import {
  GOAT_SORT_ACCESSORS,
  effectiveGoatColumns,
  goatRelEnergyText,
  parseGoatColumnPrefs,
  type GoatColumnPrefs,
  type GoatColumnVisibility,
} from "./goatDisplay";
import { Section } from "./runDetailUi";
import { useEhFormatter, useRelEnergyFormat } from "../lib/useEnergyFormat";
import { EMPTY_ENERGY, type RelEnergyFormat } from "../lib/energyUnits";

const GOAT_TABLE_ID = "goat";

const COLUMN_TOGGLES: { key: keyof GoatColumnVisibility; label: string }[] = [
  { key: "hasAbsEnergy", label: "E (Eh)" },
  { key: "hasRelativeEnergy", label: "ΔE" },
  { key: "hasDegeneracy", label: "Degen." },
  { key: "hasPercentTotal", label: "% total" },
  { key: "hasPercentCumulative", label: "% cumul." },
];

function loadColumnPrefs(): GoatColumnPrefs {
  return parseGoatColumnPrefs(readMapEntry(STORAGE_KEYS.tableColumns, GOAT_TABLE_ID));
}

function storeColumnPrefs(prefs: GoatColumnPrefs): void {
  // Best-effort: a refused write (storage full/disabled) leaves the in-memory toggles in charge.
  writeMapEntry(STORAGE_KEYS.tableColumns, GOAT_TABLE_ID, prefs);
}

export function RunGoatEnsembleTable({
  runId,
  conformers,
  columns,
  selectedIndex,
  onSelect,
}: {
  runId: string;
  conformers: GoatConformer[];
  columns: GoatColumnVisibility;
  selectedIndex: number | undefined;
  onSelect: (index: number) => void;
}) {
  const table = useTableSort(GOAT_TABLE_ID);
  const fmtEh = useEhFormatter();
  const rel = useRelEnergyFormat();
  const [prefs, setPrefs] = useState<GoatColumnPrefs>(loadColumnPrefs);

  const toggleColumn = (key: keyof GoatColumnVisibility) => {
    setPrefs((current) => {
      const next: GoatColumnPrefs = { ...current, [key]: !(current[key] ?? true) };
      storeColumnPrefs(next);
      return next;
    });
  };

  // Cumulative % stays the natural-order running total baked into each
  // conformer by the parser; sorting only reorders whole rows.
  const rows = table.sorted(conformers, GOAT_SORT_ACCESSORS);
  const { hasAbsEnergy, hasRelativeEnergy, hasDegeneracy, hasPercentTotal, hasPercentCumulative } =
    effectiveGoatColumns(columns, prefs);
  const availableToggles = COLUMN_TOGGLES.filter((t) => columns[t.key]);

  return (
    <Section
      title="Final ensemble"
      sub={
        <span>
          click a conformer to inspect it ·{" "}
          <button
            type="button"
            className="dl-btn"
            onClick={() => downloadText(`goat-ensemble-${runId.slice(0, 8)}.csv`, goatEnsembleCSV(conformers))}
          >
            Export CSV
          </button>
        </span>
      }
    >
      {availableToggles.length > 0 && (
        <div className="table-toolbar">
          {availableToggles.map((t) => {
            const visible = prefs[t.key] ?? true;
            return (
              <button
                key={t.key}
                type="button"
                className={"chip" + (visible ? " chip-active" : "")}
                aria-pressed={visible}
                title={visible ? `Hide ${t.label} column` : `Show ${t.label} column`}
                onClick={() => toggleColumn(t.key)}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="goat-table-wrap">
        <table className="table goat-table">
          <thead>
            <tr>
              <SortableTh label="Conf." sortKey="conf" table={table} />
              {hasAbsEnergy && <SortableTh label="E (Eh)" sortKey="energy" table={table} />}
              {hasRelativeEnergy && <SortableTh label="ΔE" sortKey="rel" table={table} />}
              {hasDegeneracy && <SortableTh label="Degen." sortKey="degen" table={table} defaultDir="desc" />}
              {hasPercentTotal && <SortableTh label="% total" sortKey="pctTotal" table={table} defaultDir="desc" />}
              {hasPercentCumulative && <SortableTh label="% cumul." sortKey="pctCumul" table={table} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((conf) => (
              <GoatConformerRow
                key={conf.index}
                conformer={conf}
                selected={conf.index === selectedIndex}
                onSelect={() => onSelect(conf.index)}
                showAbsEnergy={hasAbsEnergy}
                showRelativeEnergy={hasRelativeEnergy}
                showDegeneracy={hasDegeneracy}
                showPercentTotal={hasPercentTotal}
                showPercentCumulative={hasPercentCumulative}
                fmtEh={fmtEh}
                rel={rel}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function GoatConformerRow({
  conformer,
  selected,
  onSelect,
  showAbsEnergy,
  showRelativeEnergy,
  showDegeneracy,
  showPercentTotal,
  showPercentCumulative,
  fmtEh,
  rel,
}: {
  conformer: GoatConformer;
  selected: boolean;
  onSelect: () => void;
  showAbsEnergy: boolean;
  showRelativeEnergy: boolean;
  showDegeneracy: boolean;
  showPercentTotal: boolean;
  showPercentCumulative: boolean;
  fmtEh: (eh: number | null | undefined) => string;
  rel: RelEnergyFormat;
}) {
  return (
    <tr className={selected ? "goat-row-selected" : undefined} onClick={onSelect}>
      <td className="mono">#{conformer.index}</td>
      {showAbsEnergy && (
        <td className="mono">
          {fmtEh(conformer.absoluteEnergyEh)}
        </td>
      )}
      {showRelativeEnergy && (
        <td className="mono">
          {conformer.relativeEnergyKcalMol != null ? goatRelEnergyText(conformer.relativeEnergyKcalMol, rel) : EMPTY_ENERGY}
        </td>
      )}
      {showDegeneracy && <td className="mono">{conformer.degeneracy ?? ""}</td>}
      {showPercentTotal && (
        <td>
          {conformer.percentTotal != null && (
            <div className="goat-pop-cell">
              <span className="mono">{conformer.percentTotal.toFixed(2)}%</span>
              <span className="goat-pop-bar"><span style={{ width: `${Math.max(0, Math.min(100, conformer.percentTotal))}%` }} /></span>
            </div>
          )}
        </td>
      )}
      {showPercentCumulative && (
        <td className="mono">
          {conformer.percentCumulative != null ? `${conformer.percentCumulative.toFixed(2)}%` : ""}
        </td>
      )}
    </tr>
  );
}
