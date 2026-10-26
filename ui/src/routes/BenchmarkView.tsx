import { useMemo, useState } from "react";
import { Callout, Section } from "./runDetailUi";
import type { Run } from "../data/types";
import { groupRunsByMethod } from "../lib/benchmarkUtils";
import { BenchmarkChart } from "./BenchmarkChart";
import { BenchmarkTable } from "./BenchmarkTable";
import { TRUNCATION_TITLE } from "../lib/truncation";

export function BenchmarkView({
  runs,
  expId,
  capped = false,
}: {
  runs: Run[];
  expId: string;
  /** True when `runs` is the backend-capped newest slice. A method whose runs
   *  are all older than the cutoff is absent from the comparison entirely —
   *  the most dangerous kind of missing data, because nothing looks wrong. */
  capped?: boolean;
}) {
  const [refIdx, setRefIdx] = useState(0);

  const groups = useMemo(() => groupRunsByMethod(runs), [runs]);

  const refEnergy = groups[refIdx]?.bestEnergy;
  const reGrouped = useMemo(
    () => (refEnergy != null ? groupRunsByMethod(runs, refEnergy) : groups),
    [runs, refEnergy, groups],
  );

  if (reGrouped.length === 0) {
    return (
      <div className="empty-state">
        No finished runs with energy data to compare. Run calculations with
        different methods on the same molecule, then switch to the Benchmark tab.
      </div>
    );
  }

  if (reGrouped.length === 1) {
    return (
      <div className="empty-state">
        Only one method found. Run the same molecule with a different
        functional or basis set to compare.
      </div>
    );
  }

  return (
    <>
      <Section
        title="Method comparison"
        sub={
          <span>
            {reGrouped.length} methods · reference:{" "}
            <select
              className="benchmark-ref-select"
              value={refIdx}
              onChange={(e) => setRefIdx(Number(e.target.value))}
            >
              {groups.map((g, i) => {
                const name = g.runs[0]?.name ?? g.key;
                return (
                  <option key={g.key} value={i}>
                    {name} ({g.key})
                  </option>
                );
              })}
            </select>
          </span>
        }
      >
        {capped && (
          <Callout tone="warn">
            <span title={TRUNCATION_TITLE}>
              Only the most recent {runs.length} runs of this experiment are
              loaded. A method used only in older runs will not appear here, and
              the reference energy is the best among the loaded runs.
            </span>
          </Callout>
        )}
        <BenchmarkChart groups={reGrouped} />
      </Section>

      <Section title="Comparison table">
        <BenchmarkTable groups={reGrouped} expId={expId} />
      </Section>
    </>
  );
}
