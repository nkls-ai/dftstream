// Deterministic error diagnosis (roadmap P1-3): the user-facing half of the
// wrapper's rule-based failure classifier.
//
// SINGLE SOURCE OF TRUTH for the error classes in the UI. The string values
// mirror ErrorClass in wrapper/internal/parser/diagnostics.go and ERROR_CLASS
// in db/convex/schema.ts — adding a member there means adding it here, and the
// Record below is exhaustive over the union so a missing entry fails to
// compile.
//
// The prose is grounded in the ORCA 6 manual's Troubleshooting chapter and the
// ORCA Input Library's "Common Errors and Problems" catalogue — the failure
// modes are a small, documented set, which is what makes rule-based diagnosis
// accurate without an LLM.

export const ERROR_CLASSES = [
  "scf_not_converged",
  "opt_max_cycles",
  "out_of_memory",
  "disk_or_scratch",
  "geometry_exploded",
  "charge_mult_impossible",
  "unstable_wavefunction",
  "basis_or_ecp_missing",
  "external_tool_failed",
  "input_error",
  "unknown",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

export interface DiagnosisLink {
  label: string;
  href: string;
}

/** A concrete `dftstream ...` invocation the user can copy. The command
 *  string is the whole contract with the wrapper — the UI never triggers
 *  execution itself (one-click resubmission is a later wrapper-side task). */
export interface CliRemedy {
  kind: "cli";
  /** May contain the RUN_OUT / INPUT_FILE placeholders; resolve with
   *  resolveRemedyCommand before display. */
  command: string;
  explanation: string;
}

/** An edit to the input file, described in plain English plus the exact
 *  keywords/blocks involved (rendered as chips, and later consumed by the
 *  "one-click fixed input" wrapper extension). */
export interface InputChangeRemedy {
  kind: "input-change";
  description: string;
  keywords: string[];
}

export type Remedy = CliRemedy | InputChangeRemedy;

export interface Diagnosis {
  /** Short chip label (2-4 words) for tables and badges. */
  label: string;
  /** Panel headline. */
  title: string;
  /** Plain-English cause, written for a first-year PhD student. */
  cause: string;
  /** Extra severity guidance where the same symptom spans harmless-to-fatal
   *  (e.g. small vs. large imaginary frequencies). */
  severityNote?: string;
  links: DiagnosisLink[];
  remedies: Remedy[];
}

// ---- Reference links (real, verified URLs — do not invent paths) -----------

export const MANUAL_TROUBLESHOOTING_LINK: DiagnosisLink = {
  label: "ORCA manual — Troubleshooting",
  href: "https://orca-manual.mpi-muelheim.mpg.de/contents/quickstartguide/troubleshooting.html",
};

const MANUAL_OPTIMIZATIONS_LINK: DiagnosisLink = {
  label: "ORCA manual — Geometry optimizations",
  href: "https://orca-manual.mpi-muelheim.mpg.de/contents/structurereactivity/optimizations.html",
};

const LIBRARY_COMMON_ERRORS_LINK: DiagnosisLink = {
  label: "ORCA Input Library — Common errors and problems",
  href: "https://sites.google.com/site/orcainputlibrary/orca-common-errors-and-problems",
};

const LIBRARY_SCF_CONVERGENCE_LINK: DiagnosisLink = {
  label: "ORCA Input Library — SCF convergence issues",
  href: "https://sites.google.com/site/orcainputlibrary/scf-convergence-issues",
};

// ---- Command placeholders ---------------------------------------------------

/** Placeholder for the run's ORCA output file in CLI remedy commands. */
export const RUN_OUT_PLACEHOLDER = "<run.out>";
/** Placeholder for the run's input file in CLI remedy commands. */
export const INPUT_FILE_PLACEHOLDER = "<input.inp>";

/** Substitutes the run's actual file paths into a remedy command template.
 *  The .out path is derived from the input path the wrapper recorded (ORCA
 *  writes `<stem>.out` next to `<stem>.inp`). Unknown paths leave the
 *  placeholder so the command is still an honest template. */
export function resolveRemedyCommand(
  command: string,
  run: { inputPath?: string },
): string {
  let out = command;
  const inp = run.inputPath?.trim();
  if (inp) {
    out = out.replaceAll(INPUT_FILE_PLACEHOLDER, inp);
    const stem = inp.replace(/\.inp$/i, "");
    out = out.replaceAll(RUN_OUT_PLACEHOLDER, `${stem}.out`);
  }
  return out;
}

// ---- The table --------------------------------------------------------------

export const DIAGNOSES: Record<ErrorClass, Diagnosis> = {
  scf_not_converged: {
    label: "SCF not converged",
    title: "The SCF did not converge",
    cause:
      "The self-consistent field iterations never met the convergence threshold, so no wavefunction — and therefore no energy — exists for this geometry. " +
      "When the energy oscillates between two values, the orbital occupation is usually flipping between two near-degenerate solutions; this is common for systems with a small HOMO–LUMO gap such as transition-metal complexes, radicals, and stretched or breaking bonds. " +
      "When the energy creeps downward but runs out of iterations, convergence is real but damped — the fix is more iterations plus stronger damping, not a different method.",
    links: [LIBRARY_SCF_CONVERGENCE_LINK, MANUAL_TROUBLESHOOTING_LINK],
    remedies: [
      {
        kind: "input-change",
        description:
          "Add ! SlowConv (or ! VerySlowConv for the stubborn cases) to increase damping and level shifting, and raise the iteration cap with %scf MaxIter 500 end. If it still oscillates, converge a smaller basis set first and read that wavefunction in as the guess (! MOREAD with %moinp).",
        keywords: ["SlowConv", "VerySlowConv", "%scf MaxIter 500 end", "MOREAD"],
      },
    ],
  },

  opt_max_cycles: {
    label: "Hit max opt cycles",
    title: "The optimization ran out of cycles before converging",
    cause:
      "The geometry optimizer hit its cycle limit before all convergence criteria were met, so the final structure is not a stationary point and its energy must not be quoted as one. " +
      "Beware: ORCA still prints \"ORCA TERMINATED NORMALLY\" at the end of such a run — the manual explicitly warns that the banner says nothing about whether the optimization converged. " +
      "Typical causes are a flat potential energy surface (floppy torsions, weakly bound complexes) where each step barely lowers the energy, or late-stage oscillation where integration-grid noise is comparable to the remaining forces.",
    severityNote:
      "If a frequency calculation follows, judge imaginary modes by size: modes larger than roughly 50i cm⁻¹ usually mark a genuine saddle point — displace along that mode and reoptimize. Small imaginary modes below that are often numerical noise from the integration grid; a tighter grid (! DefGrid3) or tighter optimization (! TightOpt) usually removes them without changing the chemistry.",
    links: [MANUAL_OPTIMIZATIONS_LINK, MANUAL_TROUBLESHOOTING_LINK],
    remedies: [
      {
        kind: "cli",
        command: `dftstream restart ${RUN_OUT_PLACEHOLDER}`,
        explanation:
          "Builds a resubmission input that continues Opt Freq from the last geometry reached, so the cycles already spent are not wasted.",
      },
      {
        kind: "input-change",
        description:
          "Raise the cycle limit with %geom MaxIter 200 end. If the optimizer oscillates near convergence, refresh the curvature information periodically with %geom Recalc_Hess 5 end so the steps stop overshooting.",
        keywords: ["%geom MaxIter 200 end", "%geom Recalc_Hess 5 end", "TightOpt"],
      },
    ],
  },

  out_of_memory: {
    label: "Out of memory",
    title: "The run ran out of memory",
    cause:
      "%maxcore tells ORCA how much memory each parallel process may plan its algorithms around — it is a planning figure, not an operating-system limit, and correlated steps (MP2, coupled cluster, the RIJCOSX gradient) can transiently allocate more than it. " +
      "The process dies when the actual allocations, summed over every parallel process on the node, exceed the physical RAM. " +
      "Remember the total is %maxcore × nprocs: doubling the core count without lowering %maxcore doubles the memory request.",
    links: [MANUAL_TROUBLESHOOTING_LINK, LIBRARY_COMMON_ERRORS_LINK],
    remedies: [
      {
        kind: "input-change",
        description:
          "Set %maxcore to about 75% of the node's RAM divided by the number of processes — e.g. 64 GB and 8 processes: 0.75 × 65536 / 8 ≈ %maxcore 6000 (MB per process). The 25% headroom absorbs the transient overshoots. Alternatively keep %maxcore and run fewer processes, giving each one more room.",
        keywords: ["%maxcore 6000", "%pal nprocs 8 end"],
      },
      {
        kind: "cli",
        command: `dftstream restart ${RUN_OUT_PLACEHOLDER}`,
        explanation:
          "After fixing %maxcore, builds a resubmission input from the last geometry so converged optimization work is kept.",
      },
    ],
  },

  disk_or_scratch: {
    label: "Disk / scratch",
    title: "The scratch directory or disk failed",
    cause:
      "The run could not write its temporary files — the disk filled up, a quota was exceeded, or the scratch directory disappeared or was never writable. " +
      "Integral and amplitude files for correlated methods (MP2, coupled cluster) can reach hundreds of gigabytes, and a shared network filesystem or a small /tmp fills quickly. " +
      "Everything computed before the write failure is fine; the output after it is not.",
    links: [MANUAL_TROUBLESHOOTING_LINK, LIBRARY_COMMON_ERRORS_LINK],
    remedies: [
      {
        kind: "cli",
        command: `dftstream submit -submit ${INPUT_FILE_PLACEHOLDER}`,
        explanation:
          "Stages the job into its own directory and runs it on node-local scratch, copying only the results back — the standard cure for shared-filesystem and quota failures.",
      },
      {
        kind: "input-change",
        description:
          "Free space or raise the quota on the scratch filesystem, or shrink the integral storage itself: RI-J / RIJCOSX approximations (on by default for DFT in ORCA 6) and RI-MP2 keep the large intermediates in memory-sized batches instead of on disk.",
        keywords: ["RIJCOSX", "RI-MP2"],
      },
    ],
  },

  geometry_exploded: {
    label: "Geometry exploded",
    title: "The structure fell apart during optimization",
    cause:
      "ORCA could no longer build or convert its internal coordinates because atoms drifted unphysically far apart or collapsed onto each other. " +
      "The usual suspects: a broken starting structure (coordinates in Bohr pasted into an Ångström block, or vice versa), a wrong charge or multiplicity that makes the molecule genuinely want to dissociate, or optimization steps too large for a fragile structure. " +
      "The last geometries in the output are already unphysical, so restarting from them rarely helps — fix the input and start from a sane structure.",
    links: [MANUAL_OPTIMIZATIONS_LINK, LIBRARY_COMMON_ERRORS_LINK],
    remedies: [
      {
        kind: "input-change",
        description:
          "Inspect the starting structure and its units (bond lengths of ~0.5 Å or ~2.8 Å for C–H are the classic Bohr/Ångström mix-up), verify the charge and multiplicity describe the species you mean, and if the structure is fragile cap the step size with %geom MaxStep 0.1 end (default 0.3 au).",
        keywords: ["%geom MaxStep 0.1 end", "* xyz 0 1"],
      },
    ],
  },

  charge_mult_impossible: {
    label: "Impossible charge/multiplicity",
    title: "The charge and multiplicity cannot both be right",
    cause:
      "The multiplicity is 2S+1, so an even number of electrons requires an odd multiplicity (singlet, triplet, …) and an odd number of electrons requires an even one (doublet, quartet, …). " +
      "ORCA counts the electrons from the elements in your structure minus the charge, and the pair you gave has the wrong parity — the requested state cannot exist for that electron count. " +
      "This is almost always a bookkeeping slip: a protonation or deprotonation without updating the charge, a radical written as a closed-shell singlet, or a counter-ion left out of the coordinates.",
    links: [MANUAL_TROUBLESHOOTING_LINK, LIBRARY_COMMON_ERRORS_LINK],
    remedies: [
      {
        kind: "input-change",
        description:
          "Recount the electrons and fix the coordinate header (* xyz <charge> <multiplicity>): neutral even-electron molecule → 0 1; neutral radical → 0 2; after adding H⁺ the charge goes up by one and the electron count is unchanged.",
        keywords: ["* xyz 0 1", "* xyz 0 2"],
      },
    ],
  },

  unstable_wavefunction: {
    label: "Unstable wavefunction",
    title: "The converged wavefunction is not the stable one",
    cause:
      "The SCF converged, but the stability analysis found a direction in orbital-rotation space that lowers the energy — the solution is a saddle point of the SCF equations, not a minimum, and ORCA's attempt to reconverge onto the stable solution failed. " +
      "The classic case is a restricted (RHF/RKS) description of a molecule with biradical character or a stretched bond, where a spin-symmetry-broken unrestricted solution lies lower. " +
      "Energies from an unstable wavefunction are not trustworthy, so this failure is protecting you from a wrong number.",
    links: [LIBRARY_SCF_CONVERGENCE_LINK, MANUAL_TROUBLESHOOTING_LINK],
    remedies: [
      {
        kind: "input-change",
        description:
          "Run unrestricted (! UKS or ! UHF) and let ORCA follow the instability: %scf StabPerform true StabRestartUHFifUnstable true end reconverges onto the lower, stable solution automatically. Check the resulting <S**2> for spin contamination.",
        keywords: ["UKS", "%scf StabPerform true StabRestartUHFifUnstable true end"],
      },
    ],
  },

  basis_or_ecp_missing: {
    label: "Basis / ECP missing",
    title: "No basis set or ECP for one of your elements",
    cause:
      "The basis set you chose has no parameters (or no effective core potential) for at least one element in the structure. " +
      "Many classic basis sets simply stop partway down the periodic table — the Pople sets fade out after the third row, and heavier elements need an ECP the set may not define. " +
      "This also happens when a .gbw or guess file from a different basis is read against the current one, so check that any MOREAD source matches.",
    links: [LIBRARY_COMMON_ERRORS_LINK, MANUAL_TROUBLESHOOTING_LINK],
    remedies: [
      {
        kind: "input-change",
        description:
          "Switch to a basis family that covers every element in the molecule — def2-SVP / def2-TZVP span H–Rn and load the matching def2-ECP for the heavy elements automatically — or assign a per-element basis explicitly in a %basis block (NewGTO / NewECP).",
        keywords: ["def2-TZVP", "%basis NewGTO ... end"],
      },
    ],
  },

  external_tool_failed: {
    label: "External tool failed",
    title: "An ORCA module or external program died",
    cause:
      "An auxiliary step — an internal module (numerical frequencies, CIS/TD-DFT, orca_plot) or an external program ORCA calls (xtb, NBO) — terminated with an error partway through the run. " +
      "Beware the banner: ORCA can print \"ORCA TERMINATED NORMALLY\" and exit 0 even after a module died mid-run, so the tail of the .out looks clean to anything that only greps for the banner. Trust this diagnosis and the excerpt, not the last line of the file. " +
      "Everything the run completed before the module failure (for example a converged optimization) is intact and reusable.",
    links: [MANUAL_TROUBLESHOOTING_LINK, LIBRARY_COMMON_ERRORS_LINK],
    remedies: [
      {
        kind: "cli",
        command: `dftstream restart ${RUN_OUT_PLACEHOLDER}`,
        explanation:
          "Classifies the output and builds a resubmission input — if the optimization had already converged, the restart is a frequency-only rerun from the converged geometry, so no optimization work is repeated.",
      },
    ],
  },

  input_error: {
    label: "Input error",
    title: "ORCA rejected the input file",
    cause:
      "The input never made it past parsing — a misspelled keyword, a % block without its closing end, an option that does not exist in this ORCA version, or two keywords that cannot be combined. " +
      "No chemistry happened at all, so nothing about the molecule or method choice is implicated; the fix is purely textual. " +
      "The excerpt below usually quotes the exact line ORCA choked on.",
    links: [MANUAL_TROUBLESHOOTING_LINK, LIBRARY_COMMON_ERRORS_LINK],
    remedies: [
      {
        kind: "cli",
        command: `dftstream lint ${INPUT_FILE_PLACEHOLDER}`,
        explanation:
          "Checks the input file for syntax and consistency problems without running ORCA, so you can iterate on the fix in seconds.",
      },
      {
        kind: "input-change",
        description:
          "Fix the line named in the excerpt: check the spelling of every ! keyword against the manual, and make sure every % block is closed with its own end.",
        keywords: ["end"],
      },
    ],
  },

  unknown: {
    label: "Unclassified",
    title: "The run failed for an unrecognized reason",
    cause:
      "The run terminated abnormally, but none of the known failure patterns appear in its output. " +
      "Common causes outside ORCA's control: the scheduler killed the job at its walltime limit, the node crashed or was drained, or the process was killed by hand. " +
      "Read the excerpt below and the tail of the .out file — the last lines before the silence usually say which step was underway.",
    links: [MANUAL_TROUBLESHOOTING_LINK, LIBRARY_COMMON_ERRORS_LINK],
    remedies: [
      {
        kind: "cli",
        command: `dftstream restart ${RUN_OUT_PLACEHOLDER}`,
        explanation:
          "Classifies the .out with the restart triage (OK / IMAG / FREQ_BROKE / OPT_BROKE) and, when the pattern is one it knows, writes a resubmission input that keeps the completed work.",
      },
    ],
  },
};

// ---- Lookups ----------------------------------------------------------------

const ERROR_CLASS_SET: ReadonlySet<string> = new Set(ERROR_CLASSES);

export function isKnownErrorClass(v: string | undefined | null): v is ErrorClass {
  return v != null && ERROR_CLASS_SET.has(v);
}

/** Full diagnosis for a stored errorClass, or undefined when the class is
 *  absent or from a newer wrapper this build predates. */
export function diagnosisFor(errorClass: string | undefined | null): Diagnosis | undefined {
  return isKnownErrorClass(errorClass) ? DIAGNOSES[errorClass] : undefined;
}

/** Short label for tables/chips. Unknown keys are humanized rather than
 *  dropped — the column is an open string on purpose (a newer wrapper may
 *  report a class this build predates). */
export function errorClassLabel(key: string): string {
  return diagnosisFor(key)?.label ?? key.replace(/_/g, " ");
}
