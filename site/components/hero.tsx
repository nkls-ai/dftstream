import Link from "next/link";

import { AppTour } from "@/components/app-tour";
import { InstallCommand } from "@/components/install-command";
import { Route, SITE } from "@/lib/nav";

/** Product first: what DFTStream is, in the biggest type on the page. */
export function Hero() {
  return (
    <section className="border-b border-line-soft">
      <div className="mx-auto max-w-6xl px-5 pb-16 pt-14 md:px-6 md:pb-20 md:pt-20">
        <div className="grid gap-10">
          <div className="min-w-0 max-w-3xl">
            <h1 className="os-rise text-[34px] font-semibold leading-[1.08] tracking-[-0.025em] text-text sm:text-[44px] md:text-[56px]">
              The <span className="text-accent">experiment tracker</span> for your ORCA runs.
            </h1>

            <p
              className="os-rise mt-5 max-w-xl text-[15px] leading-relaxed text-muted"
              style={{ animationDelay: "120ms" }}
            >
              Run <code className="font-mono text-[0.9em] font-medium text-accent">dftstream run</code> instead
              of <code className="font-mono text-[0.9em] text-text">orca</code> and every job
              streams into a live dashboard: convergence while it runs, a clear verdict when it
              stops, and every run your group has ever done searchable in one place.
            </p>

            <div className="os-rise mt-8 max-w-xl" style={{ animationDelay: "180ms" }}>
              <InstallCommand />
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
                <a href={`${SITE.repo}#install`} className="font-medium text-accent hover:underline">
                  Install →
                </a>
                <Link href={Route.Docs} className="text-muted transition-colors hover:text-text">
                  Docs
                </Link>
                <span className="font-mono text-[11px] text-faint">
                  One binary · Linux · macOS · no root · no conda
                </span>
              </div>
            </div>
          </div>

          <div className="os-rise min-w-0 pt-2" style={{ animationDelay: "240ms" }}>
            <AppTour />
          </div>
        </div>
      </div>
    </section>
  );
}
