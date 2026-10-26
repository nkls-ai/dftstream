import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { escapeForMdx } from "./markdown";
import { DOC_NAV, Route, SITE, type DocNavItem } from "./nav";

/**
 * The site renders the repository's docs/ folder, the same files GitHub shows,
 * so the documentation exists exactly once.
 */
const DOCS_DIR = path.join(process.cwd(), "..", "docs");

export interface DocPage {
  readonly nav: DocNavItem;
  readonly body: string;
}

export function findDocNavItem(slug: string): DocNavItem | undefined {
  return DOC_NAV.find((item) => item.slug === slug);
}

/**
 * The sidebar and docs/ must describe the same set of pages. A nav entry
 * without a file is caught by loadDoc, but a file without a nav entry would
 * be silently missing from the site. Run from generateStaticParams so the
 * build fails on it.
 */
export function assertDocNavMatchesContent(): void {
  let files: string[];
  try {
    files = readdirSync(DOCS_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -".md".length));
  } catch (err) {
    throw new Error(`Cannot list "${DOCS_DIR}": ${(err as Error).message}`);
  }

  const navSlugs = new Set(DOC_NAV.map((item) => item.slug));
  const orphanFiles = files.filter((slug) => !navSlugs.has(slug));
  const missingFiles = DOC_NAV.filter((item) => !files.includes(item.slug)).map((item) => item.slug);

  const problems: string[] = [];
  if (orphanFiles.length > 0) {
    problems.push(`docs/{${orphanFiles.join(",")}}.md have no DOC_NAV entry in lib/nav.ts`);
  }
  if (missingFiles.length > 0) {
    problems.push(`DOC_NAV lists ${missingFiles.join(", ")} but docs/ has no such .md`);
  }
  if (problems.length > 0) throw new Error(`Docs nav is out of sync: ${problems.join("; ")}`);
}

/**
 * Relative links in docs/ are written for GitHub. Links to a sibling page
 * become site routes; links that leave docs/ (../AGENTS.md, ../LICENSE)
 * point at the file on GitHub.
 */
function rewriteLinks(markdown: string): string {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (match, target: string) => {
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) return match;
    const sibling = /^([a-z0-9-]+)\.md(#[\w-]+)?$/i.exec(target);
    if (sibling) return `](${Route.Docs}/${sibling[1]}/${sibling[2] ?? ""})`;
    const outside = /^\.\.\/(.+)$/.exec(target);
    if (outside) return `](${SITE.repo}/blob/main/${outside[1]})`;
    return `](${SITE.repo}/blob/main/docs/${target})`;
  });
}

/** Reads one doc. Throws with the offending path so a bad build fails loudly. */
export async function loadDoc(slug: string): Promise<DocPage> {
  const nav = findDocNavItem(slug);
  if (!nav) throw new Error(`No DOC_NAV entry for slug "${slug}"; add it to lib/nav.ts`);

  const file = path.join(DOCS_DIR, `${slug}.md`);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new Error(`Cannot read doc "${file}": ${(err as Error).message}`);
  }
  return { nav, body: escapeForMdx(rewriteLinks(raw)) };
}

export function neighbours(slug: string): { prev?: DocNavItem; next?: DocNavItem } {
  const index = DOC_NAV.findIndex((item) => item.slug === slug);
  if (index < 0) return {};
  return { prev: DOC_NAV[index - 1], next: DOC_NAV[index + 1] };
}
