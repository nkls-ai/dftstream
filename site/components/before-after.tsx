/**
 * The pitch in one comparison: how a run looks with plain ORCA, and how the
 * same run looks wrapped in DFTStream. One word changes on the command line;
 * everything downstream of it does.
 */

interface TerminalLine {
  readonly text: string;
  /** Shell input lines get a `$` prompt; output lines do not. */
  readonly input: boolean;
}

const BEFORE_TERMINAL: readonly TerminalLine[] = [
  { text: "orca ts-search.inp > ts-search.out", input: true },
  { text: "tail -f ts-search.out", input: true },
  { text: "grep TERMINATED ts-search.out", input: true },
  { text: "        ****ORCA TERMINATED NORMALLY****", input: false },
];

const AFTER_TERMINAL: readonly TerminalLine[] = [
  { text: "dftstream run ts-search.inp --exp study-A", input: true },
  { text: "tracking live → study-A / ts-search", input: false },
];

enum RunState {
  Converged = "converged",
  Running = "running",
}

interface ExperimentRun {
  readonly name: string;
  readonly state: RunState;
}

/** The run lands in an experiment, next to the runs before it. */
const EXPERIMENT_RUNS: readonly ExperimentRun[] = [
  { name: "reactant-opt", state: RunState.Converged },
  { name: "product-opt", state: RunState.Converged },
  { name: "ts-search", state: RunState.Running },
];

const RUN_PILL: Record<RunState, { readonly className: string; readonly label: string }> = {
  [RunState.Converged]: { className: "os-pill os-pill-ok", label: "Converged" },
  [RunState.Running]: { className: "os-pill os-pill-accent", label: "Running" },
};

export function BeforeAfter() {
  return (
    <section className="border-b border-line-soft">
      <div className="mx-auto max-w-6xl px-5 py-16 md:px-6 md:py-20">
        <h2 className="max-w-2xl text-[26px] font-semibold leading-tight tracking-[-0.02em] text-text md:text-[34px]">
          A wrapper around ORCA.
        </h2>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
          One binary. Same inputs, same scheduler, same output files — byte for byte.
        </p>

        <div className="mt-10 grid items-stretch gap-4 lg:grid-cols-2">
          <figure className="os-panel flex min-w-0 flex-col p-5 md:p-6">
            <figcaption className="os-label">Plain ORCA</figcaption>
            <Terminal lines={BEFORE_TERMINAL} />
            <p className="mt-4 flex-1 text-[13.5px] leading-relaxed text-muted">
              The banner prints even when nothing converged. The real answer is buried in the
              output file.
            </p>
          </figure>

          <figure className="os-panel flex min-w-0 flex-col p-5 md:p-6">
            <figcaption className="os-label">With DFTStream</figcaption>
            <Terminal lines={AFTER_TERMINAL} />
            <div className="os-sunken mt-4 p-4">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-mono text-[12px] font-medium text-text">study-A</span>
                <span className="os-label">experiment</span>
              </div>
              <ul className="mt-3 space-y-2">
                {EXPERIMENT_RUNS.map((run) => (
                  <li key={run.name} className="flex items-center justify-between gap-4">
                    <span className="font-mono text-[12px] text-muted">{run.name}</span>
                    <span className={RUN_PILL[run.state].className}>
                      <span className="dot" aria-hidden />
                      {RUN_PILL[run.state].label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-4 flex-1 text-[13.5px] leading-relaxed text-muted">
              The run lands in an experiment — live now, searchable forever.
            </p>
          </figure>
        </div>
      </div>
    </section>
  );
}

function Terminal({ lines }: { lines: readonly TerminalLine[] }) {
  return (
    <pre className="os-sunken mt-4 overflow-x-auto p-4 font-mono text-[12px] leading-loose">
      {lines.map((line) => (
        <div key={line.text} className={line.input ? "text-text" : "text-faint"}>
          {line.input && <span className="mr-2 select-none text-faint">$</span>}
          {line.input ? <CommandLine text={line.text} /> : line.text}
        </div>
      ))}
    </pre>
  );
}

/** Shell-style highlighting: the command name gets the accent colour. */
function CommandLine({ text }: { text: string }) {
  const spaceIndex = text.indexOf(" ");
  if (spaceIndex < 0) return <span className="text-accent">{text}</span>;
  return (
    <>
      <span className="font-medium text-accent">{text.slice(0, spaceIndex)}</span>
      {text.slice(spaceIndex)}
    </>
  );
}
