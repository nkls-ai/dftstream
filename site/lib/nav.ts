/** Site-wide typed configuration. No stringly-typed routes or section keys. */

export const SITE = {
  name: "DFTStream",
  tagline: "experiment tracking for ORCA",
  description:
    "Live progress, a searchable history of every ORCA run your group has ever done, and a straight answer to “did it actually converge, and what next?” — one binary, no database to administer.",
  // Canonical URL for page metadata. Update it when the site is deployed.
  url: "https://nkls-ai.github.io/dftstream",
  repo: "https://github.com/nkls-ai/dftstream",
  installCommand:
    "curl -fsSL https://raw.githubusercontent.com/nkls-ai/dftstream/main/scripts/install.sh | bash",
} as const;

export enum Route {
  Home = "/",
  Docs = "/docs",
  Changelog = "/changelog",
  Privacy = "/privacy",
}

export interface NavLink {
  readonly label: string;
  readonly href: Route | string;
  readonly external?: boolean;
}

export const PRIMARY_NAV: readonly NavLink[] = [
  { label: "Docs", href: Route.Docs },
  { label: "Changelog", href: Route.Changelog },
  { label: "GitHub", href: SITE.repo, external: true },
];

/** Secondary links shown only in the footer (legal, project meta). */
export const FOOTER_NAV: readonly NavLink[] = [
  { label: "Privacy", href: Route.Privacy },
  { label: "Report an issue", href: `${SITE.repo}/issues`, external: true },
];

export enum DocSection {
  Using = "Using DFTStream",
  Running = "Running it",
  Project = "Project",
}

export interface DocNavItem {
  /** File name in the repository's docs/ folder, without `.md`. */
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly section: DocSection;
}

/** Order and grouping of the documentation sidebar. One entry per docs/*.md file. */
export const DOC_NAV: readonly DocNavItem[] = [
  { slug: "usage", title: "Usage", description: "Experiments and runs, job types, verdicts and the transition-state workflow.", section: DocSection.Using },
  { slug: "cli", title: "CLI reference", description: "Every dftstream command and flag.", section: DocSection.Using },
  { slug: "clusters", title: "Clusters", description: "SLURM submission and compute nodes without network.", section: DocSection.Running },
  { slug: "operations", title: "Running a backend", description: "Local, Docker and cloud backends, configuration, upgrades and backups.", section: DocSection.Running },
  { slug: "auth", title: "Multi-user auth", description: "Organizations, roles, CLI login and machine tokens.", section: DocSection.Running },
  { slug: "setup-with-agent", title: "Setup with an agent", description: "Step-by-step install instructions for coding agents.", section: DocSection.Project },
  { slug: "development", title: "Development", description: "Architecture, building, tests and releases.", section: DocSection.Project },
];

export const DOC_SECTIONS: readonly DocSection[] = [DocSection.Using, DocSection.Running, DocSection.Project];
