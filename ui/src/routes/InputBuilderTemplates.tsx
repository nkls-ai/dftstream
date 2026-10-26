import { useState } from "react";
import { useDataSource } from "../data/DataSource";
import { orgQueryArg, useOrg } from "../auth/OrgContext";
import { usePrompt, useConfirm } from "../components/Confirm";
import { userErrorMessage } from "../lib/errorReporting";
import {
  applyTemplate,
  deserializeTemplateState,
  serializeTemplateState,
  TEMPLATE_STATE_VERSION,
} from "../lib/inputBuilder/templates";
import type { BuilderState } from "../lib/inputBuilder/builderState";

/**
 * The group's shared template library: save the current settings under a
 * name, or load a colleague's. The molecule is never part of a template
 * — the structure on screen stays exactly where it is when one is loaded.
 */
export function InputBuilderTemplates({
  state,
  onLoad,
}: {
  state: BuilderState;
  onLoad: (next: BuilderState) => void;
}) {
  const ds = useDataSource();
  const org = useOrg();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const templates = ds.useInputTemplates(orgQueryArg(org));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  async function save() {
    const name = await prompt({
      title: "Save as template",
      message: "Name this set of settings for the group",
      placeholder: "Solvated Opt+Freq, r2SCAN-3c",
    });
    if (!name) return;
    setBusy(true);
    setErrors([]);
    setNotes([]);
    try {
      await ds.createInputTemplate(
        {
          name,
          description: describe(state),
          state: serializeTemplateState(state),
          stateVersion: TEMPLATE_STATE_VERSION,
        },
        org.activeOrgId,
      );
      setNotes([`saved "${name}"`]);
    } catch (err) {
      setErrors([userErrorMessage(err, "save the template")]);
    } finally {
      setBusy(false);
    }
  }

  function load(id: string) {
    const row = (templates.data ?? []).find((t) => t.id === id);
    if (!row) return;
    const loaded = deserializeTemplateState(row.state, row.stateVersion);
    if (!loaded.ok) {
      setErrors([`${row.name}: ${loaded.error}`]);
      setNotes([]);
      return;
    }
    setErrors([]);
    setNotes(loaded.notes);
    onLoad(applyTemplate(state, loaded.state));
  }

  async function remove(id: string, name: string) {
    const ok = await confirm({
      title: "Delete template",
      message: `Delete "${name}"? Everyone in the organization loses it.`,
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await ds.removeInputTemplate(id);
      setErrors([]);
    } catch (err) {
      setErrors([userErrorMessage(err, "delete the template")]);
    } finally {
      setBusy(false);
    }
  }

  const rows = templates.data ?? [];

  return (
    <div className="ib-templates">
      <div className="ib-row">
        <button type="button" className="button" disabled={busy} onClick={() => void save()}>
          Save as template
        </button>
        <span className="dim">
          Settings only — the structure is never stored in a template.
        </span>
      </div>

      {templates.loading ? (
        <span className="dim">Loading templates…</span>
      ) : rows.length === 0 ? (
        <span className="dim">No templates yet.</span>
      ) : (
        <ul className="ib-template-list">
          {rows.map((t) => (
            <li key={t.id} className="ib-template">
              <span className="ib-template-name">{t.name}</span>
              <span className="dim">{t.description}</span>
              <span className="ib-template-actions">
                <button type="button" className="dl-btn" onClick={() => load(t.id)}>
                  Load
                </button>
                <button type="button" className="dl-btn" disabled={busy} onClick={() => void remove(t.id, t.name)}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {errors.length > 0 && (
        <ul className="ib-findings">
          {errors.map((e, i) => (
            <li key={i} className="ib-finding error">
              {e}
            </li>
          ))}
        </ul>
      )}
      {notes.length > 0 && (
        <ul className="ib-findings">
          {notes.map((n, i) => (
            <li key={i} className="ib-finding info">
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One line naming what a template actually does, for the list. */
function describe(state: BuilderState): string {
  const bits = [state.job, state.presetId];
  if (state.env.solvent) bits.push(`${state.env.model}(${state.env.solvent})`);
  if (state.env.charge !== 0 || state.env.multiplicity !== 1) {
    bits.push(`charge ${state.env.charge}, mult ${state.env.multiplicity}`);
  }
  return bits.join(" · ");
}
