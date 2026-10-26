
import { BeforeAfter } from "@/components/before-after";
import { FeatureGrid } from "@/components/feature-grid";
import { Hero } from "@/components/hero";
import { ShotPlayer } from "@/components/shot-player";
import { SITE } from "@/lib/nav";

interface ChainStep {
  readonly command: string;
  readonly result: string;
}

const CHAIN: readonly ChainStep[] = [
  { command: "dftstream run reactant.inp --exp study-A", result: "tracked live, artifacts captured" },
  { command: "dftstream next neb-ts reactant.out product.out", result: "endpoints validated, NEB-TS written" },
  { command: "dftstream next irc ts.out", result: "refused unless exactly one imaginary mode" },
  { command: "dftstream next opt-endpoints irc.out", result: "both endpoints, Opt Freq" },
  { command: "dftstream next sp min.out", result: "DLPNO-CCSD(T) refinement, solvent carried over" },
];

export default function HomePage() {
  return (
    <>
      <Hero />
      <BeforeAfter />

      <section className="border-b border-line-soft">
        <div className="mx-auto max-w-6xl px-5 py-16 md:px-6 md:py-20">
          <h2 className="max-w-2xl text-[26px] font-semibold leading-tight tracking-[-0.02em] text-text md:text-[34px]">
            Follow every run, <span className="text-accent">live</span>.
          </h2>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
            Any calculation type. Updates while the job runs, scrub back through it after.
          </p>

          <div className="mt-10">
            <ShotPlayer />
          </div>
        </div>
      </section>

      <FeatureGrid />

      <section className="border-b border-line-soft">
        <div className="mx-auto max-w-6xl px-5 py-16 md:px-6 md:py-20">
          <h2 className="max-w-2xl text-[26px] font-semibold leading-tight tracking-[-0.02em] text-text md:text-[34px]">
            It writes the <span className="text-accent">next input</span>.
          </h2>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
            Each step inherits method, resources, charge and multiplicity from the run before it.
          </p>

          <div className="os-card mt-10 overflow-x-auto">
            <table className="os-table">
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  <th>Command</th>
                  <th>What DFTStream does</th>
                </tr>
              </thead>
              <tbody>
                {CHAIN.map((step, index) => (
                  <tr key={step.command}>
                    <td className="num text-faint">{String(index + 1).padStart(2, "0")}</td>
                    <td className="num text-text">
                      <span className="font-medium text-accent">
                        {step.command.split(" ", 1)[0]}
                      </span>
                      {step.command.slice(step.command.indexOf(" "))}
                    </td>
                    <td className="text-muted">{step.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section>
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-5 py-16 md:flex-row md:items-center md:justify-between md:px-6 md:py-20">
          <div>
            <h2 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-text md:text-[32px]">
              Start with one run.
            </h2>
            <p className="mt-3 max-w-md text-[14px] leading-relaxed text-muted">
              Install takes a minute and needs no root. Outputs you already have can be pulled in
              with <code className="font-mono text-[0.9em] font-medium text-accent">dftstream import-experiments</code>.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-[13px] font-medium">
            <a
              href={`${SITE.repo}#install`}
              className="rounded-lg px-5 py-2.5 text-white transition-opacity hover:opacity-90"
              style={{ background: "var(--os-accent)" }}
            >
              Install
            </a>
            <a
              href={SITE.repo}
              className="rounded-lg border border-line px-5 py-2.5 text-text transition-colors hover:border-accent hover:text-accent"
            >
              Source on GitHub
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
