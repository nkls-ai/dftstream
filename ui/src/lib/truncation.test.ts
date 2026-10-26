import { test, expect } from "bun:test";
import {
  countLabel,
  filteredCountLabel,
  relativeEnergyCaveat,
  runCountLabel,
} from "./truncation";

// Regression: RunsPage rendered `${runs.data.length} runs` straight from
// runs.listByExperiment, which ends in .take(1000). An experiment with 4200
// runs read "1000 runs" — an exact-looking number that was simply wrong, with
// nothing on screen to suggest anything was missing.
test("runCountLabel marks a capped count as a lower bound", () => {
  expect(runCountLabel(1000, true)).toBe("1000+ runs");
  expect(runCountLabel(37, false)).toBe("37 runs");
});

test("runCountLabel keeps the singular only for a genuine count of one", () => {
  expect(runCountLabel(1, false)).toBe("1 run");
  // "1+ run" would be wrong: capped means at least one more exists.
  expect(runCountLabel(1, true)).toBe("1+ runs");
  expect(runCountLabel(0, false)).toBe("0 runs");
});

test("countLabel is the bare number plus the cap marker", () => {
  expect(countLabel(1000, true)).toBe("1000+");
  expect(countLabel(1000, false)).toBe("1000");
});

// The denominator of a filtered view over a capped list is the loaded slice.
// "12 of 1000 runs" implies the experiment has 1000 runs and 988 did not
// match; both halves of that are false.
test("filteredCountLabel says 'loaded' when the list is capped", () => {
  expect(filteredCountLabel(12, 1000, true)).toBe(
    "12 of 1000 loaded runs — older runs are not loaded",
  );
  expect(filteredCountLabel(12, 40, false)).toBe("12 of 40 runs");
});

test("relativeEnergyCaveat only fires for a capped list", () => {
  expect(relativeEnergyCaveat(false)).toBeNull();
  const warning = relativeEnergyCaveat(true);
  expect(warning).toBeString();
  expect(warning).toContain("offset");
});
