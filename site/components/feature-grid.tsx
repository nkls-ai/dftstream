import type { ReactNode } from "react";

/**
 * Features shown, not told: each card is a small artifact in the product's
 * own idiom — a convergence trace, verdict pills, a checksum diff — with a
 * short title underneath.
 */

const JOB_TYPES: readonly string[] = ["OPT", "FREQ", "TS", "NEB", "IRC", "SCAN", "TDDFT", "GOAT"];

interface HistoryRow {
  readonly run: string;
  readonly energy: string;
  readonly dg: string;
}

const HISTORY_ROWS: readonly HistoryRow[] = [
  { run: "reactant-opt", energy: "−265.0702", dg: "0.0" },
  { run: "ts-search", energy: "−265.0410", dg: "+18.3" },
  { run: "product-opt", energy: "−265.0661", dg: "+2.5" },
];

export function FeatureGrid() {
  return (
    <section className="border-b border-line-soft">
      <div className="mx-auto max-w-6xl px-5 py-16 md:px-6 md:py-20">
        <h2 className="max-w-2xl text-[26px] font-semibold leading-tight tracking-[-0.02em] text-text md:text-[34px]">
          What you get.
        </h2>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card title="Live convergence">
            <svg viewBox="0 0 220 64" className="w-full" aria-hidden>
              <polyline
                points="4,10 32,26 60,20 88,36 116,32 144,46 172,50 200,55 216,57"
                fill="none"
                stroke="var(--os-accent)"
                strokeWidth="2"
                strokeLinecap="round"
                className="os-trace"
              />
              <circle cx="216" cy="57" r="3.5" fill="var(--os-accent)" />
            </svg>
          </Card>

          <Card title="Every job type">
            <div className="flex flex-wrap justify-center gap-1.5">
              {JOB_TYPES.map((type) => (
                <span
                  key={type}
                  className="rounded-md border border-line-soft px-2 py-1 font-mono text-[10.5px] text-muted"
                >
                  {type}
                </span>
              ))}
            </div>
          </Card>

          <Card title="Honest verdicts">
            <div className="flex flex-wrap justify-center gap-2">
              <span className="os-pill os-pill-ok">
                <span className="dot" aria-hidden />
                Converged
              </span>
              <span className="os-pill os-pill-warn">
                <span className="dot" aria-hidden />
                Max cycles
              </span>
              <span className="os-pill os-pill-danger">
                <span className="dot" aria-hidden />
                Crashed
              </span>
            </div>
          </Card>

          <Card title="The next input, written">
            <div className="font-mono text-[12px]">
              <div>
                <span className="mr-2 select-none text-faint">$</span>
                <span className="font-medium text-accent">dftstream</span>
                <span className="text-text"> next irc ts.out</span>
              </div>
              <div className="mt-2 text-muted">
                ts.out <span className="text-accent">→</span> irc.inp
              </div>
            </div>
          </Card>

          <Card title="The whole group's history">
            <div className="w-full font-mono text-[11px] leading-relaxed">
              <div className="flex justify-between gap-3 text-faint">
                <span>run</span>
                <span className="flex gap-5">
                  <span>Eh</span>
                  <span>ΔG</span>
                </span>
              </div>
              {HISTORY_ROWS.map((row) => (
                <div key={row.run} className="flex justify-between gap-3 border-t border-line-soft pt-1 mt-1">
                  <span className="text-muted">{row.run}</span>
                  <span className="flex gap-5 text-text">
                    <span>{row.energy}</span>
                    <span>{row.dg}</span>
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Files untouched">
            <div className="font-mono text-[11px] leading-loose">
              <div className="text-muted">
                md5 orca/ts.gbw <span className="ml-3 text-text">3f9ab2…</span>
              </div>
              <div className="text-muted">
                md5 tracked/ts.gbw <span className="ml-3 text-text">3f9ab2…</span>
                <span className="ml-3 text-ok">✓ identical</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="os-card p-5">
      <div className="os-sunken flex min-h-[104px] items-center justify-center overflow-x-auto px-4 py-4">
        {children}
      </div>
      <h3 className="mt-4 text-[14px] font-semibold leading-snug text-text">{title}</h3>
    </article>
  );
}
