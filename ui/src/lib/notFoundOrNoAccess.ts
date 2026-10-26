// "Not found, or no access" — one answer for both, so the UI never reveals
// whether another org's experiment, run or pathway exists. Opening one by URL
// used to show the backend's raw text ("not a member of this organization"),
// which says exactly that it does.

/** What a detail route shows. */
export const EntityKind = {
  EXPERIMENT: "experiment",
  RUN: "run",
  PATHWAY: "pathway",
  PAGE: "page",
} as const;

export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

export const ENTITY_LABEL: Record<EntityKind, string> = {
  [EntityKind.EXPERIMENT]: "Experiment",
  [EntityKind.RUN]: "Run",
  [EntityKind.PATHWAY]: "Pathway",
  [EntityKind.PAGE]: "Page",
};

/** The user-facing sentence, shared by pages, the route boundary and userErrorMessage. */
export const NOT_FOUND_OR_NO_ACCESS = "It does not exist, or you do not have access to it.";

// Backend refusals (db/convex/authz.ts) and validator failures that mean
// "this id is not yours to read": a foreign org, a deleted parent, or an id
// that is malformed or from another table.
const PATTERNS: readonly RegExp[] = [
  /\bnot a member of (this|any) organization\b/i,
  /\bCLI token is not authorized for this organization\b/i,
  /\b(experiment|run|pathway|artifact|batch) not found\b/i,
  /\bexperiment has no organization\b/i,
  /\bArgumentValidationError\b/,
];

export function isNotFoundOrNoAccess(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return PATTERNS.some((re) => re.test(message));
}

/** The entity a pathname shows, from the route shapes in lib/routes.ts. */
export function entityForPath(pathname: string): EntityKind {
  if (/^\/experiments\/[^/]+\/runs\/[^/]+/.test(pathname)) return EntityKind.RUN;
  if (/^\/experiments\/[^/]+\/pathways\/[^/]+/.test(pathname)) return EntityKind.PATHWAY;
  if (/^\/experiments\/[^/]+\/?$/.test(pathname)) return EntityKind.EXPERIMENT;
  return EntityKind.PAGE;
}
