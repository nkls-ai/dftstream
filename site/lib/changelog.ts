import { readFile } from "node:fs/promises";
import path from "node:path";

import { escapeForMdx } from "./markdown";

/**
 * The changelog page is generated from the repository CHANGELOG.md at build
 * time — one source of truth for what shipped.
 */
const CHANGELOG_PATH = path.join(process.cwd(), "..", "CHANGELOG.md");

export interface ChangelogRelease {
  readonly version: string;
  readonly date: string | null;
  readonly body: string;
}

export async function loadChangelog(): Promise<readonly ChangelogRelease[]> {
  let raw: string;
  try {
    raw = await readFile(CHANGELOG_PATH, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ${CHANGELOG_PATH}: ${(err as Error).message}`);
  }

  const releases: ChangelogRelease[] = [];
  let current: { version: string; date: string | null; lines: string[] } | null = null;

  /** Single place a release is sealed, so the MDX escape can never be skipped. */
  const flush = (release: typeof current): void => {
    if (!release) return;
    releases.push({
      version: release.version,
      date: release.date,
      body: escapeForMdx(release.lines.join("\n").trim()),
    });
  };

  for (const line of raw.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush(current);
      const title = heading[1];
      const dated = /^(.+?)\s+\((\d{4}-\d{2}-\d{2})\)$/.exec(title);
      current = {
        version: dated ? dated[1] : title,
        date: dated ? dated[2] : null,
        lines: [],
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush(current);

  if (releases.length === 0) {
    throw new Error(`No "## <version>" headings found in ${CHANGELOG_PATH} — the changelog page would render empty`);
  }
  return releases;
}
