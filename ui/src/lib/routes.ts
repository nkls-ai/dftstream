// Typed builders for every in-app navigation target. Link/navigate call
// sites use these instead of hand-assembled template strings, so a path
// change happens in one place (App.tsx's <Route> patterns must be kept in
// sync with the shapes below).
export const routes = {
  experiments: "/experiments",
  tools: "/tools",
  newInput: "/new-input",
  settings: "/settings",
  cliLink: "/cli-link",
  compare: "/compare",
  experiment: (expId: string) => `/experiments/${expId}`,
  run: (expId: string, runId: string) => `/experiments/${expId}/runs/${runId}`,
  pathway: (expId: string, pathwayId: string) => `/experiments/${expId}/pathways/${pathwayId}`,
} as const;
