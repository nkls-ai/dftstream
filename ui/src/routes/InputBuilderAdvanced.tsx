import {
  AUX_BASIS_CHOICES,
  BASIS_CHOICES,
  DispersionOverride,
  FUNCTIONAL_CHOICES,
  GridOverride,
  RIOverride,
  ScfOverride,
  methodOverridesApply,
  type AdvancedOverrides,
} from "../lib/inputBuilder/overrides";
import { MethodFamily } from "../lib/inputBuilder/types";

/**
 * The §3 advanced panel: typed override selects for functional, basis,
 * aux basis, grid, SCF convergence, dispersion and RI mode. Each one
 * REPLACES the preset's token of that category rather than adding a
 * second one; "preset" leaves it exactly as the preset shipped it.
 *
 * The free-text keyword and block boxes stay at the bottom — the escape
 * hatch for the corner of ORCA nobody has modelled yet, applied last.
 */
export function InputBuilderAdvanced({
  overrides,
  family,
  extraKeywords,
  extraBlocks,
  onOverrides,
  onExtraKeywords,
  onExtraBlocks,
}: {
  overrides: AdvancedOverrides;
  family: MethodFamily | null;
  extraKeywords: string;
  extraBlocks: string;
  onOverrides: (next: AdvancedOverrides) => void;
  onExtraKeywords: (value: string) => void;
  onExtraBlocks: (value: string) => void;
}) {
  const patch = (next: Partial<AdvancedOverrides>) => onOverrides({ ...overrides, ...next });
  // A composite bundles its own basis and corrections and xTB has
  // neither; offering the selects there would build a line ORCA rejects.
  const methodApplies = family !== null && methodOverridesApply(family);

  return (
    <div className="ib-grid">
      {methodApplies ? (
        <>
          <Choice
            label="Functional"
            value={overrides.functional}
            options={FUNCTIONAL_CHOICES}
            onChange={(functional) => patch({ functional })}
          />
          <Choice
            label="Basis set"
            value={overrides.basis}
            options={BASIS_CHOICES}
            onChange={(basis) => patch({ basis })}
          />
          <Choice
            label="Auxiliary basis"
            value={overrides.auxBasis}
            options={AUX_BASIS_CHOICES}
            hint="The fitting basis RI needs; AutoAux derives one."
            onChange={(auxBasis) => patch({ auxBasis })}
          />
          <Choice
            label="Dispersion"
            value={overrides.dispersion}
            options={[DispersionOverride.D3BJ, DispersionOverride.D4, DispersionOverride.NL]}
            hint="Leave on preset when the functional already carries its correction (wB97X-D4)."
            onChange={(dispersion) => patch({ dispersion: dispersion as DispersionOverride })}
          />
          <Choice
            label="RI mode"
            value={overrides.ri}
            options={[RIOverride.RIJCOSX, RIOverride.RIJK, RIOverride.NoRI]}
            hint="RIJCOSX is the usual hybrid speed-up; it needs an auxiliary basis."
            onChange={(ri) => patch({ ri: ri as RIOverride })}
          />
        </>
      ) : (
        <div className="ib-field">
          <span>Method</span>
          <span className="dim">
            This method has no functional or basis to override — a composite brings its own, and xTB has
            neither. Grid and SCF still apply.
          </span>
        </div>
      )}

      <Choice
        label="Integration grid"
        value={overrides.grid}
        options={[GridOverride.DefGrid1, GridOverride.DefGrid2, GridOverride.DefGrid3]}
        hint="DEFGRID3 for frequencies and small energy differences."
        onChange={(grid) => patch({ grid: grid as GridOverride })}
      />
      <Choice
        label="SCF convergence"
        value={overrides.scf}
        options={[ScfOverride.Normal, ScfOverride.Tight, ScfOverride.VeryTight]}
        hint="TightSCF is the floor for thermochemistry and any energy difference under a kcal."
        onChange={(scf) => patch({ scf: scf as ScfOverride })}
      />

      <label className="ib-field">
        <span>Extra keywords</span>
        <input
          type="text"
          className="mono"
          placeholder="NoAutoStart MOREAD"
          value={extraKeywords}
          onChange={(e) => onExtraKeywords(e.target.value)}
        />
        <span className="dim">Appended to the '!' line last; duplicates are dropped.</span>
      </label>
      <label className="ib-field">
        <span>Extra blocks</span>
        <textarea
          className="mono"
          rows={4}
          spellCheck={false}
          placeholder={"%scf\n  MaxIter 300\nend"}
          value={extraBlocks}
          onChange={(e) => onExtraBlocks(e.target.value)}
        />
        <span className="dim">Emitted verbatim after the typed blocks.</span>
      </label>
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  hint,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  hint?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="ib-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">from the preset</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {hint && <span className="dim">{hint}</span>}
    </label>
  );
}
