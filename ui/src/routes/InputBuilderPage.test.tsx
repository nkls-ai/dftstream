import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { DataSourceProvider, type DataSource } from "../data/DataSource";
import { DialogProvider } from "../components/Confirm";
import { InputBuilderPage } from "./InputBuilderPage";
import { JOB_TYPES } from "../lib/inputBuilder/presets";

/**
 * The page mounts inside the app's providers; here they are the smallest
 * thing that satisfies the hooks it actually calls. Anything else being
 * reached is a bug worth failing on, so the stub does not answer it.
 */
const stub = {
  useExperiments: () => ({ data: [], loading: false }),
  useRunsByExperiment: () => ({ data: [], loading: false, capped: false }),
  useRunGeometries: () => ({ data: [], loading: false }),
  useInputTemplates: () => ({ data: [], loading: false }),
} as unknown as DataSource;

/** The rendered text with the markup removed, for asserting on content
 *  that the highlighter splits across spans. */
function stripTags(html: string): string {
  return html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, "");
}

function render(node: React.ReactNode): string {
  return renderToString(
    <DialogProvider>
      <DataSourceProvider value={stub}>{node}</DataSourceProvider>
    </DialogProvider>,
  );
}

/**
 * Render smoke test: the builder must come up with the lab's default
 * input already in the preview, before the user touches anything.
 */
test("the page renders with the default input in the preview", () => {
  const html = render(<InputBuilderPage />);
  expect(html).toContain("New input");
  // The preview is syntax-highlighted, so the keyword line arrives as
  // tokens; stripping the markup is what "what will ORCA see" means.
  expect(stripTags(html)).toContain("! r2SCAN-3c Opt Freq");
  // No structure yet — the builder says so instead of pretending.
  expect(html).toContain("no structure yet");
  // The preset ranking is visible where the choice is made.
  expect(html).toContain("241");
});

test("the submit handoff shows the exact command", () => {
  const html = render(<InputBuilderPage />);
  expect(html).toContain("dftstream submit job.inp");
});

test("every job type the presets offer is selectable", () => {
  const html = render(<InputBuilderPage />);
  // A job in the YAML with no option here would be unreachable, which is
  // the exact gap the P1-1 audit found for the route itself.
  for (const job of JOB_TYPES) {
    expect(html).toContain(`value="${job.id}"`);
  }
  // The four jobs added in P1-1 specifically.
  for (const id of ["scan", "tddft", "nmr", "mecp"]) {
    expect(JOB_TYPES.some((j) => j.id === id)).toBe(true);
  }
});
