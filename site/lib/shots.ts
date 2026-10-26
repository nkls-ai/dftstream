/**
 * The product screenshots in `public/shots/`.
 *
 * Every one is a headless capture of the running app against a backend seeded
 * from this repo's own `.examples/` ORCA outputs — malonaldehyde tautomerization
 * at r2SCAN-3c and GFN2-xTB, HCN→HNC isomerization by NEB-CI. The numbers on
 * screen are the numbers ORCA produced. See `.ai_scripts/site-capture/`.
 */

export enum ShotId {
  Experiments = "experiments",
  RunsTable = "runs-table",
  Energies = "energies",
  TsVerdict = "ts-verdict",
  RunOverview = "run-overview",
  Structure = "structure",
  NebPath = "neb-path",
  IrcPath = "irc-path",
}

export interface Shot {
  readonly id: ShotId;
  /** Short label, shown as the frame's caption. */
  readonly label: string;
  /** One line on what the chemist is looking at. */
  readonly caption: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly alt: string;
}

const DIMENSIONS = { width: 1440, height: 900 } as const;

function shot(id: ShotId, label: string, caption: string, alt: string): Shot {
  return { id, label, caption, alt, src: `/shots/${id}.png`, ...DIMENSIONS };
}

export const SHOTS: readonly Shot[] = [
  shot(
    ShotId.RunsTable,
    "Runs",
    "Every run in a study, with its keywords, its verdict and its energy.",
    "DFTStream runs table: five runs of a malonaldehyde tautomerization study, each with status, ORCA keywords, a convergence verdict and its final energy.",
  ),
  shot(
    ShotId.TsVerdict,
    "Transition state",
    "One imaginary mode at −301 cm⁻¹. That is what makes it a transition state.",
    "DFTStream transition-state view: a Valid TS verdict, the imaginary frequency, the optimization convergence trace and the frequency spectrum.",
  ),
  shot(
    ShotId.IrcPath,
    "IRC",
    "The saddle point walked down to both minima, with the geometry at every step.",
    "DFTStream IRC view: the reaction-coordinate energy profile from reactant through the saddle point to product, beside the 3D structure.",
  ),
  shot(
    ShotId.RunOverview,
    "Run overview",
    "Final energy, whether it converged, Gibbs G, imaginary modes — above the input that produced them.",
    "DFTStream run overview: final single-point energy, converged status, Gibbs free energy, zero imaginary modes, method metadata and the ORCA input file.",
  ),
  shot(
    ShotId.Structure,
    "Structure",
    "Scrub through the optimization and watch the geometry move with the energy.",
    "DFTStream structure view: a 3D molecular model beside the per-cycle optimization energy trace.",
  ),
  shot(
    ShotId.NebPath,
    "NEB",
    "The minimum energy path, its images, and which one is the climbing image.",
    "DFTStream NEB view: eight images along a minimum energy path with a 73.23 kcal per mole barrier and the climbing image marked.",
  ),
  shot(
    ShotId.Energies,
    "Energies",
    "ΔE and ΔG across the whole experiment, in one table, CSV out.",
    "DFTStream energies table: electronic energy, relative energy, Gibbs free energy and relative Gibbs free energy for every run in an experiment.",
  ),
  shot(
    ShotId.Experiments,
    "Experiments",
    "Everything the group has ever run, not just what is still in your shell history.",
    "DFTStream experiment index: a grid of cards, one per study, each showing run counts, methods and last activity.",
  ),
];

/** The animated click-through, and its still for prefers-reduced-motion. */
export const TOUR = {
  gif: "/shots/tour.gif",
  poster: "/shots/tour-poster.png",
  width: 1152,
  height: 720,
  alt: "A click-through of DFTStream: the experiment index, a runs table, a transition-state verdict, an IRC path and the energies table.",
  steps: ["Experiments", "Runs", "Transition state", "IRC path", "Energies"],
} as const;
