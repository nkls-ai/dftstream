import { useState } from "react";
import { IR_SCALE_PRESETS } from "../lib/irSpectrum";

/** Table of per-method/basis IR frequency scaling factors with add/remove and NIST presets. */
export function IRScaleFactorEditor({
  factors,
  onChange,
}: {
  factors: Record<string, number>;
  onChange: (f: Record<string, number>) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const entries = Object.entries(factors);
  const presetKeys = Object.keys(IR_SCALE_PRESETS).filter((k) => !(k in factors));

  return (
    <div className="ir-scale-editor">
      {entries.length > 0 && (
        <table className="ir-scale-table">
          <thead>
            <tr><th>Method/Basis</th><th>Factor</th><th aria-label="Actions"></th></tr>
          </thead>
          <tbody>
            {entries.map(([key, val]) => (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td className="mono">{val.toFixed(4)}</td>
                <td>
                  <button
                    type="button"
                    className="ir-scale-remove"
                    onClick={() => {
                      const next = { ...factors };
                      delete next[key];
                      onChange(next);
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="ir-scale-add">
        <input aria-label="Method/Basis"
          className="settings-input"
          placeholder="Method/Basis (e.g. B3LYP/def2-SVP)"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          list="ir-presets"
        />
        <input aria-label="Scale factor"
          className="settings-input settings-input-narrow"
          placeholder="0.9700"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          type="number"
          step="0.0001"
          min="0.5"
          max="1.5"
        />
        <button
          type="button"
          className="settings-btn-add"
          disabled={!newKey.trim() || !newValue}
          onClick={() => {
            const val = parseFloat(newValue);
            if (newKey.trim() && !isNaN(val) && val > 0) {
              onChange({ ...factors, [newKey.trim()]: val });
              setNewKey("");
              setNewValue("");
            }
          }}
        >
          Add
        </button>
      </div>

      {presetKeys.length > 0 && (
        <details className="ir-scale-presets">
          <summary>Load from NIST presets</summary>
          <div className="ir-scale-preset-list">
            {presetKeys.map((key) => (
              <button
                key={key}
                type="button"
                className="ir-scale-preset-btn"
                onClick={() => onChange({ ...factors, [key]: IR_SCALE_PRESETS[key]! })}
              >
                {key} ({IR_SCALE_PRESETS[key]!.toFixed(4)})
              </button>
            ))}
          </div>
        </details>
      )}

      <datalist id="ir-presets">
        {Object.keys(IR_SCALE_PRESETS).map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </datalist>
    </div>
  );
}
