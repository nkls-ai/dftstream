import type { Metadata } from "next";

import { Mdx } from "@/components/mdx";
import { loadChangelog } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Everything that shipped in DFTStream, generated from the repository changelog.",
};

export default async function ChangelogPage() {
  const releases = await loadChangelog();

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 md:px-6 md:py-16">
      <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.025em] text-text md:text-[40px]">
        Changelog
      </h1>
      <p className="mt-4 text-[14px] text-muted">
        Generated at build time from the repository&apos;s{" "}
        <code className="font-mono text-[0.9em] text-text">CHANGELOG.md</code>.
      </p>

      <div className="mt-12 space-y-14">
        {releases.map((release) => (
          <section key={release.version}>
            <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line-soft pb-3">
              <h2 className="font-mono text-[22px] font-medium tracking-[-0.01em] text-text">
                {release.version}
              </h2>
              {release.date ? (
                <time className="font-mono text-[11px] text-faint">{release.date}</time>
              ) : null}
            </header>
            <div className="prose-app mt-6">
              <Mdx source={release.body} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
