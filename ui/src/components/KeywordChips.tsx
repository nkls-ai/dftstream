import type { Run } from "../data/types";
import { prettyRunType } from "../lib/runTypeLabels";
import { type ChipKind, isXtbMethod, runTypeKind } from "./keywordKinds";

export function Chip({
  kind,
  children,
  title,
}: {
  kind: ChipKind;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip chip-${kind}`} title={title}>
      {children}
    </span>
  );
}

export function RunChips({
  run,
  compact = false,
}: {
  run: Run;
  compact?: boolean;
}) {
  return (
    <div className="chips">
      {run.runTypes?.map((t) => (
        <Chip key={`rt-${t}`} kind={runTypeKind(t)} title="Run type">
          {prettyRunType(t)}
        </Chip>
      ))}
      {run.functional && (
        <Chip kind="func" title="Functional">
          {run.functional}
        </Chip>
      )}
      {run.basis && (
        <Chip kind="basis" title="Basis set">
          {run.basis}
        </Chip>
      )}
      {!compact && run.method && !run.functional && (
        <Chip kind={isXtbMethod(run.method) ? "xtb" : "method"} title="Method">
          {run.method}
        </Chip>
      )}
      {run.scfTier && (
        <Chip kind="scf" title="SCF tier">
          {prettyScf(run.scfTier)}
        </Chip>
      )}
      {run.solvent && (
        <Chip
          kind="solvent"
          title={`${run.solventModel}(${run.solvent})`}
        >
          {run.solventModel}({run.solvent})
        </Chip>
      )}
      {!compact &&
        run.corrections?.map((c) => (
          <Chip key={`co-${c}`} kind="corr" title="Correction">
            {c}
          </Chip>
        ))}
    </div>
  );
}


function prettyScf(t: string): string {
  return (
    {
      TIGHTSCF: "TightSCF",
      VERYTIGHTSCF: "VeryTightSCF",
      NORMALSCF: "NormalSCF",
      LOOSESCF: "LooseSCF",
      SLOPPYSCF: "SloppySCF",
      EXTREMESCF: "ExtremeSCF",
      STRONGSCF: "StrongSCF",
    } as Record<string, string>
  )[t] ?? t;
}
