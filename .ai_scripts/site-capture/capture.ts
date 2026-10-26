/**
 * Capture the real DFTStream UI for the marketing site.
 *
 * Nothing here fabricates product imagery: every frame is a headless
 * Chromium screenshot of the actual app, driven against a Convex backend
 * seeded from the repo's own `.examples/` ORCA outputs.
 *
 * Prerequisites (see README.md next to this file):
 *   1. a Convex backend with the example data imported
 *   2. the UI served against it (`bun ui/src/index.ts` or `dftstream ui`)
 *   3. a headless Chromium + the unpacked GUI libs (LD_LIBRARY_PATH)
 *
 * Usage:
 *   OS_UI_URL=http://127.0.0.1:3057 \
 *   OS_OUT_DIR=/path/to/site/public/shots \
 *   LD_LIBRARY_PATH=<libs>/usr/lib/x86_64-linux-gnu:<libs>/lib/x86_64-linux-gnu \
 *   bun .ai_scripts/site-capture/capture.ts
 */
import { chromium, type Page } from "playwright-core";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import sharp from "sharp";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/* ------------------------------------------------------------------ config */

const UI = process.env.OS_UI_URL ?? "http://127.0.0.1:3057";
const OUT = process.env.OS_OUT_DIR ?? "/tmp/dftstream-shots";
const EXEC =
  process.env.OS_CHROMIUM ??
  `${homedir()}/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell`;

/** Shot geometry. Captured at 2x, shipped at 1x width. */
const SHOT = { width: 1440, height: 900, scale: 2, shipWidth: 1440 } as const;
/** The animated tour is deliberately small: it must not gate first paint. */
const TOUR = { width: 1152, height: 720, gifWidth: 1152, holdMs: 1700 } as const;

/** Experiments seeded by .ai_scripts/site-capture/seed.sh. */
enum Experiment {
  Malonaldehyde = "malonaldehyde-tautomerization",
  HcnHnc = "hcn-hnc-isomerization",
}

/** Run-detail tabs, as labelled in the app. */
enum RunTab {
  Overview = "Overview",
  TransitionState = "Transition State",
  StructureEnergy = "Structure & Energy",
  /** NEB runs. */
  Path = "Path",
  /** IRC runs get their own tab rather than the generic path one. */
  Irc = "IRC",
}

/** Experiment-level tabs, as labelled in the app. */
enum ExperimentTab {
  Runs = "Runs",
  Energies = "Energies",
}

interface Shot {
  /** File stem written into OUT, e.g. `runs-table` → `runs-table.png`. */
  readonly slug: string;
  /** Human description; printed as the capture runs. */
  readonly what: string;
  /** Drives the app to the state to be captured. */
  readonly go: (nav: Nav) => Promise<void>;
}

/* ------------------------------------------------------------- navigation */

/** Small helper around a Page: the app-specific moves the shots need. */
class Nav {
  constructor(private readonly page: Page) {}

  get raw(): Page {
    return this.page;
  }

  /** Waits until no skeleton placeholder is left on screen. */
  async settled(extraMs = 1200): Promise<void> {
    await this.page.waitForFunction(() => document.querySelectorAll(".skel").length === 0, undefined, {
      timeout: 45_000,
    });
    await this.page.waitForTimeout(extraMs);
  }

  async experiments(): Promise<void> {
    await this.page.goto(`${UI}/experiments`, { waitUntil: "networkidle", timeout: 60_000 });
    await this.settled();
  }

  async openExperiment(name: Experiment): Promise<void> {
    await this.experiments();
    await this.page.getByText(name, { exact: true }).first().click();
    await this.settled();
  }

  async experimentTab(tab: ExperimentTab): Promise<void> {
    await this.page.getByText(tab, { exact: true }).first().click();
    await this.settled(900);
  }

  /** Opens a run of the current experiment by name fragment. */
  async openRun(fragment: string): Promise<void> {
    const link = this.page.locator(`a[href*="/runs/"]`, { hasText: fragment }).first();
    await link.click();
    await this.settled(2500);
  }

  async runTab(tab: RunTab): Promise<void> {
    await this.page.getByText(tab, { exact: true }).first().click();
    await this.settled(2500);
  }

  /** Lets the 3D viewer finish its first WebGL paint. */
  async letMoleculeRender(): Promise<void> {
    await this.page.waitForTimeout(2500);
  }

  /**
   * Selects one image of a NEB path. Image 0 is an endpoint with nothing
   * interesting on screen; the climbing image is the point of the run.
   */
  async selectPathImage(index: number): Promise<void> {
    const buttons = this.page.locator("button", { hasText: new RegExp(`^${index}$`) });
    await buttons.last().click();
    await this.page.waitForTimeout(2500);
  }
}

/* ------------------------------------------------------------------ shots */

const SHOTS: readonly Shot[] = [
  {
    slug: "experiments",
    what: "Experiment index — every study the group has recorded",
    go: async (nav) => {
      await nav.experiments();
    },
  },
  {
    slug: "runs-table",
    what: "Runs table — status, keywords, convergence verdict, energies",
    go: async (nav) => {
      await nav.openExperiment(Experiment.Malonaldehyde);
      await nav.experimentTab(ExperimentTab.Runs);
    },
  },
  {
    slug: "energies",
    what: "Energies table — E(el), ΔE, Gibbs G, ΔG across the experiment",
    go: async (nav) => {
      await nav.openExperiment(Experiment.Malonaldehyde);
      await nav.experimentTab(ExperimentTab.Energies);
    },
  },
  {
    slug: "ts-verdict",
    what: "Transition state — verdict, imaginary mode, convergence, thermochemistry",
    go: async (nav) => {
      await nav.openExperiment(Experiment.Malonaldehyde);
      await nav.openRun("optts");
      await nav.runTab(RunTab.TransitionState);
      await nav.letMoleculeRender();
    },
  },
  {
    slug: "run-overview",
    what: "Run overview — what happened, per phase, with the raw numbers",
    go: async (nav) => {
      await nav.openExperiment(Experiment.Malonaldehyde);
      await nav.openRun("opt-freq");
      await nav.runTab(RunTab.Overview);
    },
  },
  {
    slug: "structure",
    what: "Structure & energy — geometry per optimization cycle, next to the trace",
    go: async (nav) => {
      await nav.openExperiment(Experiment.Malonaldehyde);
      await nav.openRun("opt-freq");
      await nav.runTab(RunTab.StructureEnergy);
      await nav.letMoleculeRender();
    },
  },
  {
    slug: "neb-path",
    what: "NEB minimum energy path — images, barrier, climbing image",
    go: async (nav) => {
      await nav.openExperiment(Experiment.HcnHnc);
      await nav.openRun("neb");
      await nav.runTab(RunTab.Path);
      await nav.selectPathImage(3); // the climbing image — the TS of the path
      await nav.letMoleculeRender();
    },
  },
  {
    slug: "irc-path",
    what: "IRC — the saddle point walked down to both minima",
    go: async (nav) => {
      await nav.openExperiment(Experiment.Malonaldehyde);
      await nav.openRun("irc");
      await nav.runTab(RunTab.Irc);
      await nav.letMoleculeRender();
    },
  },
];

/** Frames of the animated click-through, in the order they tell the story. */
const TOUR_SLUGS = ["experiments", "runs-table", "ts-verdict", "irc-path", "energies"] as const;

const TOUR_FRAMES: readonly Shot[] = TOUR_SLUGS.map((slug) => {
  const shot = SHOTS.find((s) => s.slug === slug);
  if (!shot) throw new Error(`tour references unknown shot: ${slug}`);
  return shot;
});

/* ------------------------------------------------------------------ encode */

async function writeStill(png: Buffer, slug: string): Promise<void> {
  const file = join(OUT, `${slug}.png`);
  const optimized = await sharp(png)
    .resize({ width: SHOT.shipWidth, fit: "inside", kernel: "lanczos3" })
    // The UI is flat colour on flat surfaces: a 256-entry palette is
    // lossless to the eye and roughly a quarter of the truecolour size.
    .png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
    .toBuffer();
  await writeFile(file, optimized);
  console.log(`  → ${file}  ${(optimized.byteLength / 1024).toFixed(0)} KB`);
}

/**
 * Encodes the tour as a real GIF with gifenc (pure JS — this host has no
 * ffmpeg, gifski or ImageMagick). One shared palette across all frames
 * keeps the file small and stops colours shifting between steps.
 */
async function writeGif(frames: readonly Buffer[]): Promise<void> {
  const rgba = await Promise.all(
    frames.map(async (png) => {
      const { data, info } = await sharp(png)
        .resize({ width: TOUR.gifWidth, fit: "inside", kernel: "lanczos3" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
    }),
  );

  const width = rgba[0]!.width;
  const height = rgba[0]!.height;
  // Build the palette from every frame at once so the encoder can reuse
  // the local colour table; 128 entries is plenty for a flat dark UI.
  const merged = new Uint8ClampedArray(rgba.reduce((n, f) => n + f.data.length, 0));
  let at = 0;
  for (const frame of rgba) {
    merged.set(frame.data, at);
    at += frame.data.length;
  }
  const palette = quantize(merged, 128, { format: "rgb565" });

  const gif = GIFEncoder();
  rgba.forEach((frame, index) => {
    const indexed = applyPalette(frame.data, palette, "rgb565");
    gif.writeFrame(indexed, width, height, {
      palette,
      delay: TOUR.holdMs,
      dispose: 1,
      // `repeat` is read only from the first frame, where it becomes the
      // Netscape looping extension. 0 = loop forever, so someone who lands
      // mid-cycle still sees the whole tour. Stated explicitly rather than
      // relying on gifenc's default.
      ...(index === 0 ? { repeat: 0 } : {}),
    });
  });
  gif.finish();

  const bytes = gif.bytes();
  const file = join(OUT, "tour.gif");
  await writeFile(file, bytes);
  console.log(`  → ${file}  ${(bytes.byteLength / 1024).toFixed(0)} KB  ${width}×${height}  ${rgba.length} frames`);

  // Poster for prefers-reduced-motion: the first frame, as a still.
  const poster = await sharp(frames[0]!)
    .resize({ width: TOUR.gifWidth, fit: "inside", kernel: "lanczos3" })
    .png({ palette: true, effort: 10, compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(OUT, "tour-poster.png"), poster);
  console.log(`  → ${join(OUT, "tour-poster.png")}  ${(poster.byteLength / 1024).toFixed(0)} KB`);
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });

  try {
    const failures: string[] = [];

    const still = await browser.newPage({
      viewport: { width: SHOT.width, height: SHOT.height },
      deviceScaleFactor: SHOT.scale,
    });
    still.on("pageerror", (e) => failures.push(`pageerror: ${String(e).slice(0, 200)}`));

    console.log(`stills → ${OUT}`);
    for (const shot of SHOTS) {
      console.log(`· ${shot.slug}: ${shot.what}`);
      await shot.go(new Nav(still));
      await writeStill(await still.screenshot(), shot.slug);
    }
    await still.close();

    const tourPage = await browser.newPage({
      viewport: { width: TOUR.width, height: TOUR.height },
      deviceScaleFactor: 1,
    });
    tourPage.on("pageerror", (e) => failures.push(`tour pageerror: ${String(e).slice(0, 200)}`));

    console.log("tour frames");
    const frames: Buffer[] = [];
    for (const frame of TOUR_FRAMES) {
      console.log(`· ${frame.slug}`);
      await frame.go(new Nav(tourPage));
      frames.push(await tourPage.screenshot());
    }
    await tourPage.close();
    await writeGif(frames);

    if (failures.length > 0) {
      // Page errors do not invalidate the images, but a silent one would
      // hide a broken view behind a plausible-looking screenshot.
      console.error(`\n${failures.length} page error(s) during capture:`);
      for (const f of failures) console.error(`  ! ${f}`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

await main();
