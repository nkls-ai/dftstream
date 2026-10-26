/**
 * README screenshots of the real DFTStream UI, driven headless against the
 * LOCAL backend (127.0.0.1:3210) seeded by seed.sh.
 *
 *   OS_OUT_DIR=docs/images ONLY=experiments,run-ts \
 *   LD_LIBRARY_PATH=~/.cache/orbital-chrome-libs bun .ai_scripts/readme-screenshots/capture.ts
 *
 * Env:
 *   OS_UI_URL   UI origin                (default http://localhost:3000)
 *   OS_OUT_DIR  where PNGs go             (default docs/images)
 *   ONLY        comma-separated slugs to (re)shoot, or "all"; default: the
 *               shots the README uses (README_SHOTS)
 *   LIVE_RUN    "<expId>/<runId>" of a streaming run, for the live shots
 */
import { chromium, type Browser, type Page } from "playwright-core";
import sharp from "sharp";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { experimentIds } from "./ids";

const UI = process.env.OS_UI_URL ?? "http://localhost:3000";
const OUT = process.env.OS_OUT_DIR ?? join(import.meta.dir, "../../docs/images");
const EXEC = `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell`;

/** Captured at 2x, shipped at 1.5x width: sharp text, well under 600 KB. */
const SHOT = { width: 1440, height: 900, scale: 2, shipWidth: 2160, maxKb: 350 } as const;
// The app sidebar (plus its shadow) is identical on every page; the README
// grid shows content only, so stills are cropped past it. The live GIF keeps
// it for context. In CSS px of the SHOT viewport.
export const SIDEBAR_CSS_PX = 243;

// Crops the sidebar off a still of any scale (raw capture or shipped PNG).
export async function cropSidebar(png: Buffer): Promise<Buffer> {
  const { width, height } = await sharp(png).metadata();
  if (!width || !height) throw new Error("cropSidebar: unreadable image");
  const left = Math.round((width * SIDEBAR_CSS_PX) / SHOT.width);
  return sharp(png).extract({ left, top: 0, width: width - left, height }).toBuffer();
}

enum Exp {
  Acrylophenone = "acrylophenone-conformers",
  Selenium = "organoselenium-radical-ts",
  Malonaldehyde = "malonaldehyde-proton-transfer",
  HcnNeb = "hcn-hnc-isomerization-neb",
  Formaldehyde = "formaldehyde-pes-scans",
  WaterHf = "water-hf-basis-convergence",
  ArylScreen = "aryl-conformer-screen",
  /** Pre-existing dev experiment carrying the one coherent pathway. */
  HcnExample = "hcn-hnc-example",
}

enum ExpTab {
  Runs = "Runs",
  Energies = "Energies",
  Benchmark = "Benchmark",
  Batch = "Batch Mode",
}

type Ids = Awaited<ReturnType<typeof experimentIds>>;

interface Shot {
  readonly slug: string;
  readonly what: string;
  readonly go: (nav: Nav) => Promise<void>;
  /** Full-page height to capture instead of the viewport (CSS px). */
  readonly height?: number;
}

class Nav {
  constructor(
    readonly page: Page,
    readonly ids: Ids,
  ) {}

  async settled(extraMs = 1500): Promise<void> {
    await this.page.waitForFunction(() => document.querySelectorAll(".skel").length === 0, undefined, {
      timeout: 45_000,
    });
    await this.page.waitForTimeout(extraMs);
  }

  async goto(path: string, extraMs?: number): Promise<void> {
    await this.page.goto(`${UI}${path}`, { waitUntil: "networkidle", timeout: 60_000 });
    await this.settled(extraMs);
  }

  exp(name: Exp): string {
    const e = this.ids[name];
    if (!e) throw new Error(`experiment not seeded: ${name}`);
    return `/experiments/${e.id}`;
  }

  run(name: Exp, run: string, tab: string): string {
    const e = this.ids[name];
    const r = e?.runs[run];
    if (!e || !r) throw new Error(`run not seeded: ${name}/${run}`);
    return `/experiments/${e.id}/runs/${r}?tab=${tab}`;
  }

  async expTab(tab: ExpTab): Promise<void> {
    await this.page.locator(".exp-tab-btn", { hasText: tab }).first().click();
    await this.settled(2000);
  }
}

/**
 * The experiments the README shows. Older dev experiments (scf-diag-demo,
 * spooltest-live-1, live-demo, ...) stay in the local DB untouched; the
 * index shot is cropped above the first card not in this set.
 */
export const CURATED_EXPERIMENTS: ReadonlySet<string> = new Set([
  "benzaldehyde-screen",
  "water-pes-scans",
  "water-hf-basis-convergence",
  "organoselenium-radical-ts",
  "malonaldehyde-proton-transfer",
  "hcn-hnc-isomerization-neb",
  "formaldehyde-pes-scans",
  "dicopper-co2-activation-ts",
  "b1-open-shell-singlet",
  "acrylophenone-conformers",
  "aryl-conformer-screen",
  "phenol-cpcm-solvent-scan",
]);

/** Viewport shot of /experiments, cut off above the first non-curated card. */
export async function curatedExperimentsShot(page: Page): Promise<Buffer> {
  const cards = await page.locator(".exp-card").evaluateAll((els) =>
    els.map((el) => ({
      name: el.querySelector(".exp-card-name")?.textContent?.trim() ?? "",
      top: el.getBoundingClientRect().top,
    })),
  );
  const firstOther = cards.find((c) => !CURATED_EXPERIMENTS.has(c.name));
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("page has no viewport");
  const bottom = firstOther ? Math.min(viewport.height, Math.floor(firstOther.top) - 12) : viewport.height;
  return page.screenshot({ clip: { x: 0, y: 0, width: viewport.width, height: bottom } });
}

const SHOTS: readonly Shot[] = [
  {
    slug: "experiments",
    what: "Experiment index (curated experiments only)",
    go: (n) => n.goto("/experiments", 2500),
  },
  {
    slug: "runs-table",
    what: "Runs table of a finished screening batch",
    go: (n) => n.goto(n.exp(Exp.ArylScreen)),
  },
  {
    slug: "run-overview",
    what: "Run overview: energy, convergence verdict, thermochemistry, input",
    go: (n) => n.goto(n.run(Exp.Selenium, "optts-r2scan3c", "overview")),
  },
  {
    slug: "run-structure",
    what: "Structure & Energy: 3D geometry per optimization cycle next to the energy trace",
    go: (n) => n.goto(n.run(Exp.Acrylophenone, "opt-freq", "structure"), 3000),
  },
  {
    slug: "run-transition-state",
    what: "Transition-state verdict, imaginary mode, IR spectrum",
    go: (n) => n.goto(n.run(Exp.Selenium, "optts-r2scan3c", "ts"), 3500),
  },
  {
    slug: "irc",
    what: "IRC reaction coordinate with the structure at each step",
    go: (n) => n.goto(n.run(Exp.Malonaldehyde, "irc-gfn2", "irc"), 3500),
  },
  {
    slug: "neb",
    what: "NEB-CI minimum energy path, climbing image selected",
    go: async (n) => {
      await n.goto(n.run(Exp.HcnNeb, "neb-ci-xtb", "path"), 2500);
      await n.page.locator("button", { hasText: /^3$/ }).last().click();
      await n.page.waitForTimeout(1500);
      // Scroll past the headline so the whole viewer canvas is in frame
      // next to the path chart (the viewer shows HCN side-on by default).
      await n.page.mouse.wheel(0, 130);
      await n.page.waitForTimeout(800);
    },
  },
  {
    slug: "scan-surface",
    what: "2D relaxed surface scan rendered as a 3D potential surface",
    go: (n) => n.goto(n.run(Exp.Formaldehyde, "scan-2d", "scan"), 3500),
  },
  {
    slug: "batch-dashboard",
    what: "Batch dashboard of a screening campaign",
    go: async (n) => {
      await n.goto(n.exp(Exp.ArylScreen));
      await n.expTab(ExpTab.Batch);
    },
  },
  {
    slug: "input-builder",
    what: "Input builder with a structure loaded",
    go: async (n) => {
      await n.goto("/new-input");
      const xyz = await Bun.file(join(import.meta.dir, "../../.examples/opt-freq_ma1_r2scan3c/opt-freq_ma1_r2scan3c.xyz")).text();
      await n.page.locator("textarea").first().fill(xyz);
      await n.page.getByText("Use these coordinates", { exact: true }).click();
      await n.page.waitForTimeout(1500);
      // Resources and the generated input file, rather than the paste box.
      await n.page.locator("h2", { hasText: "System & resources" }).first().evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 24));
      await n.page.waitForTimeout(1000);
    },
  },
  {
    slug: "pathway",
    what: "Reaction pathway energy profile",
    go: async (n) => {
      const e = n.ids[Exp.HcnExample];
      if (!e) throw new Error("hcn-hnc-example missing");
      await n.goto(n.exp(Exp.HcnExample));
      await n.page.locator("a[href*='/pathways/']").first().click();
      await n.settled(3000);
    },
  },
];

export async function writeStill(raw: Buffer, slug: string): Promise<void> {
  const file = join(OUT, `${slug}.png`);
  const png = await cropSidebar(raw);
  let width = Math.round((SHOT.shipWidth * (SHOT.width - SIDEBAR_CSS_PX)) / SHOT.width);
  let out: Buffer;
  // Palette PNG: the UI is flat colour, so 256 entries are invisible to the
  // eye. Step the width down only if a busy shot is still over budget.
  for (;;) {
    out = await sharp(png)
      .resize({ width, fit: "inside", kernel: "lanczos3" })
      .png({ palette: true, quality: 95, effort: 10, compressionLevel: 9, dither: 0.6 })
      .toBuffer();
    if (out.byteLength <= SHOT.maxKb * 1024 || width <= 1200) break;
    width -= 240;
  }
  await writeFile(file, out);
  console.log(`  -> ${file}  ${(out.byteLength / 1024).toFixed(0)} KB @ ${width}w`);
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
}

export async function newPage(browser: Browser, errors: string[], width = SHOT.width, height = SHOT.height, scale = SHOT.scale): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  // Run-finished toasts from the live batch would pile up over the content.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = ".toast-container { display: none !important; }";
      document.head.appendChild(style);
    });
  });
  page.on("pageerror", (e) => errors.push(`pageerror ${page.url()}: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error ${page.url()}: ${m.text().slice(0, 300)}`);
  });
  return page;
}

export const ALL_EXPERIMENTS = Object.values(Exp);

// The stills README.md shows (the experiments shot is retaken by live.ts
// with work in flight).
export const README_SHOTS = ["experiments", "run-transition-state", "scan-surface"] as const;

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const only = process.env.ONLY?.split(",").filter(Boolean) ?? [...README_SHOTS];
  const shots = only.includes("all") ? SHOTS : SHOTS.filter((s) => only.includes(s.slug));
  const ids = await experimentIds(ALL_EXPERIMENTS);
  const browser = await launch();
  const errors: string[] = [];
  try {
    for (const shot of shots) {
      console.log(`* ${shot.slug}: ${shot.what}`);
      // A fresh page per shot: no scroll/hover/selection state leaks across.
      const page = await newPage(browser, errors);
      await shot.go(new Nav(page, ids));
      const png = shot.slug === "experiments" ? await curatedExperimentsShot(page) : await page.screenshot();
      await writeStill(png, shot.slug);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  if (errors.length) {
    console.error(`\n${errors.length} page error(s):`);
    for (const e of errors) console.error(`  ! ${e}`);
  }
}

if (import.meta.main) await main();
