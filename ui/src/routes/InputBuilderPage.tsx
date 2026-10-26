import { useMemo, useState } from "react";
import { Callout, Section } from "./runDetailUi";
import { InputBuilderStructure, type StructureAdopted } from "./InputBuilderStructure";
import { InputBuilderPreview } from "./InputBuilderPreview";
import { InputBuilderAdvanced } from "./InputBuilderAdvanced";
import { InputBuilderResources } from "./InputBuilderResources";
import { InputBuilderRunPicker } from "./InputBuilderRunPicker";
import { InputBuilderTemplates } from "./InputBuilderTemplates";
import { MECPFields, ScanFields, TDDFTFields } from "./InputBuilderJobParams";
import {
  applyPreset,
  buildFiles,
  buildInputText,
  defaultBuilderState,
  needsEndpoint,
  needsFrequencies,
  needsMecp,
  needsScan,
  needsTddft,
  solventChoices,
  structureProblems,
  type BuilderState,
} from "../lib/inputBuilder/builderState";
import { lintInput } from "../lib/inputBuilder/lint";
import { allProfiles, profileById, profileProblems, type MachineProfile } from "../lib/inputBuilder/machineProfiles";
import {
  JOB_TYPES,
  PRESET_ERRORS,
  methodPresetById,
  methodPresetsFor,
  solventModelsFor,
} from "../lib/inputBuilder/presets";
import { submitCommand } from "../lib/inputBuilder/submit";
import { JobTypeId, SolventModelId } from "../lib/inputBuilder/types";

/**
 * Build an ORCA input from a structure, a job type and a method preset,
 * with the generated file visible (and editable) the whole time. The
 * presets are the lab's own most-submitted keyword lines, and the same
 * pre-flight checks the CLI runs are applied to the preview.
 */
export function InputBuilderPage() {
  const [state, setState] = useState<BuilderState>(defaultBuilderState);
  const [editedText, setEditedText] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  // Loaded once: reading localStorage on every render would re-parse the
  // store on each keystroke, and the list only changes here.
  const [profiles, setProfiles] = useState<MachineProfile[]>(allProfiles);

  const profile = profileById(state.profileId, profiles);
  const generated = useMemo(() => buildInputText(state), [state]);
  const text = editedText ?? generated;
  const files = useMemo(() => buildFiles(state, text), [state, text]);
  const findings = useMemo(
    () =>
      lintInput(text, {
        totalRAMMB: profile?.ramMB ?? 0,
        totalCores: profile?.cores ?? 0,
        availableFiles: files.map((f) => f.name),
      }),
    [text, profile, files],
  );
  const problems = [
    ...structureProblems(state),
    ...profileProblems(profile, state.walltimeHours),
  ];

  const preset = methodPresetById(state.presetId);
  const presetsForJob = methodPresetsFor(state.job);
  const solventModels = preset ? solventModelsFor(preset.family) : [];
  const solvents = solventChoices(state);
  const command = submitCommand({ fileName: files[0]?.name ?? "job.inp", cluster: profile?.cluster ?? "" });

  const patch = (next: Partial<BuilderState>) => setState((s) => ({ ...s, ...next }));

  function adopt(which: "structure" | "endpoint") {
    return (adopted: StructureAdopted) => {
      setState((s) => ({
        ...s,
        [which]: adopted.structure,
        // A source that knows its own charge/spin (a SMILES, an ORCA
        // block, a tracked run) sets them: guessing neutral singlet is
        // how a radical silently becomes a closed shell.
        env:
          which === "structure" && (adopted.charge !== undefined || adopted.multiplicity !== undefined)
            ? {
                ...s.env,
                charge: adopted.charge ?? s.env.charge,
                multiplicity: adopted.multiplicity ?? s.env.multiplicity,
              }
            : s.env,
      }));
    };
  }

  return (
    <div className="tab-shell" style={{ padding: "20px 24px" }}>
      <h1 className="page-title">New input</h1>

      {PRESET_ERRORS.length > 0 && (
        <Callout tone="bad" icon="✕">
          <div>
            The preset files could not be read completely — some choices are missing:
            <ul className="ib-findings">
              {PRESET_ERRORS.map((e, i) => (
                <li key={i} className="ib-finding error">
                  {e}
                </li>
              ))}
            </ul>
          </div>
        </Callout>
      )}

      <Section
        title="Structure"
        sub={<span>paste coordinates, upload .xyz/.mol/.sdf/.pdb, build one from a SMILES, or reuse a run's final geometry</span>}
      >
        <div className="ib-structures">
          <InputBuilderStructure
            title={needsEndpoint(state.job) ? "Reactant" : "Molecule"}
            structure={state.structure}
            onAdopt={adopt("structure")}
            onClear={() => patch({ structure: null })}
            runPicker={<InputBuilderRunPicker onAdopt={adopt("structure")} />}
          />
          {needsEndpoint(state.job) && (
            <InputBuilderStructure
              title="Product endpoint"
              hint="same atoms, same order"
              structure={state.endpoint}
              onAdopt={adopt("endpoint")}
              onClear={() => patch({ endpoint: null })}
              runPicker={<InputBuilderRunPicker onAdopt={adopt("endpoint")} />}
            />
          )}
        </div>
        {problems.length > 0 && (
          <ul className="ib-findings">
            {problems.map((p, i) => (
              <li key={i} className="ib-finding warn">
                {p}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Job" sub={<span>what to compute, and at which level</span>}>
        <div className="ib-grid">
          <label className="ib-field">
            <span>Job type</span>
            <select value={state.job} onChange={(e) => patch({ job: e.target.value as JobTypeId })}>
              {JOB_TYPES.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.label}
                </option>
              ))}
            </select>
            <span className="dim">{JOB_TYPES.find((j) => j.id === state.job)?.description}</span>
          </label>

          <label className="ib-field">
            <span>Method preset</span>
            <select value={state.presetId} onChange={(e) => setState((s) => applyPreset(s, e.target.value))}>
              {presetsForJob.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.observed !== null ? ` — ${p.observed}× in this lab` : ""}
                </option>
              ))}
              {presetsForJob.every((p) => p.id !== state.presetId) && preset && (
                <option value={preset.id}>{preset.label} (not usual for this job)</option>
              )}
            </select>
            <span className="dim">{preset?.description}</span>
          </label>

          <label className="ib-field">
            <span>File name</span>
            <input
              type="text"
              className="mono"
              value={state.baseName}
              onChange={(e) => patch({ baseName: e.target.value })}
            />
            <span className="dim">{files.map((f) => f.name).join(", ")}</span>
          </label>

          {needsEndpoint(state.job) && (
            <label className="ib-field">
              <span>NEB images</span>
              <input
                type="number"
                min={0}
                value={state.nebImages}
                onChange={(e) => patch({ nebImages: Number(e.target.value) })}
              />
              <span className="dim">0 uses ORCA's default band size</span>
            </label>
          )}

          {needsScan(state.job) && (
            <ScanFields
              scan={state.scan}
              atomCount={state.structure?.atoms.length ?? 0}
              onChange={(scan) => patch({ scan })}
            />
          )}
          {needsTddft(state.job) && <TDDFTFields tddft={state.tddft} onChange={(tddft) => patch({ tddft })} />}
          {needsMecp(state.job) && (
            <MECPFields mecp={state.mecp} mult1={state.env.multiplicity} onChange={(mecp) => patch({ mecp })} />
          )}
        </div>

        <button type="button" className="dl-btn" onClick={() => setAdvanced((a) => !a)}>
          {advanced ? "Hide" : "Show"} advanced overrides
        </button>
        {advanced && (
          <InputBuilderAdvanced
            overrides={state.overrides}
            family={preset?.family ?? null}
            extraKeywords={state.extraKeywords}
            extraBlocks={state.extraBlocks}
            onOverrides={(overrides) => patch({ overrides })}
            onExtraKeywords={(extraKeywords) => patch({ extraKeywords })}
            onExtraBlocks={(extraBlocks) => patch({ extraBlocks })}
          />
        )}
      </Section>

      <Section title="System &amp; resources" sub={<span>charge, spin, solvent, and what the machine can give it</span>}>
        <div className="ib-grid">
          <label className="ib-field">
            <span>Charge</span>
            <input
              type="number"
              value={state.env.charge}
              onChange={(e) => patch({ env: { ...state.env, charge: Number(e.target.value) } })}
            />
          </label>
          <label className="ib-field">
            <span>Multiplicity</span>
            <input
              type="number"
              min={1}
              value={state.env.multiplicity}
              onChange={(e) => patch({ env: { ...state.env, multiplicity: Number(e.target.value) } })}
            />
            <span className="dim">2S+1 — checked against the electron count below</span>
          </label>
          <label className="ib-field">
            <span>Solvent model</span>
            <select
              value={state.env.model}
              onChange={(e) =>
                patch({ env: { ...state.env, model: e.target.value as SolventModelId, solvent: "" } })
              }
            >
              <option value={SolventModelId.None}>gas phase</option>
              {solventModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="ib-field">
            <span>Solvent</span>
            <select
              value={state.env.solvent}
              disabled={state.env.model === SolventModelId.None}
              onChange={(e) => patch({ env: { ...state.env, solvent: e.target.value } })}
            >
              <option value="">—</option>
              {solvents.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          {needsFrequencies(state.job) && (
            <>
              <label className="ib-field">
                <span>Temperature (K)</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={state.thermo.temperatureK || ""}
                  placeholder="298.15 (ORCA's default)"
                  onChange={(e) => patch({ thermo: { ...state.thermo, temperatureK: Number(e.target.value) } })}
                />
                <span className="dim">Thermochemistry only — the geometry and energies are unaffected.</span>
              </label>
              <label className="ib-field">
                <span>Pressure (atm)</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={state.thermo.pressureAtm || ""}
                  placeholder="1.0 (ORCA's default)"
                  onChange={(e) => patch({ thermo: { ...state.thermo, pressureAtm: Number(e.target.value) } })}
                />
              </label>
            </>
          )}

          <InputBuilderResources
            profiles={profiles}
            profileId={state.profileId}
            res={state.res}
            walltimeHours={state.walltimeHours}
            onProfile={(profileId) =>
              patch({ profileId, totalRAMMB: profileById(profileId, profiles)?.ramMB ?? 0 })
            }
            onProfiles={setProfiles}
            onRes={(res) => patch({ res })}
            onWalltime={(walltimeHours) => patch({ walltimeHours })}
          />
        </div>
      </Section>

      <Section title="Templates" sub={<span>the group's saved settings — the molecule is never part of one</span>}>
        <InputBuilderTemplates
          state={state}
          onLoad={(next) => {
            setState(next);
            // A loaded template rebuilds the input; keeping a hand-edit
            // on top of it would silently ignore what was just loaded.
            setEditedText(null);
          }}
        />
      </Section>

      <Section title="Input file" sub={<span>edit it freely — the checks follow what is in the box</span>}>
        <InputBuilderPreview
          text={text}
          edited={editedText !== null}
          findings={findings}
          files={files}
          submitCommand={command}
          onEdit={setEditedText}
          onRegenerate={() => setEditedText(null)}
        />
      </Section>
    </div>
  );
}
