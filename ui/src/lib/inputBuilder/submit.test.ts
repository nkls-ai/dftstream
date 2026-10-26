import { expect, test } from "bun:test";
import { shellQuote, submitCommand } from "./submit";

test("the plain command is the one the docs show", () => {
  expect(submitCommand({ fileName: "job.inp" })).toBe("dftstream submit job.inp");
  expect(submitCommand({ fileName: "job.inp", cluster: "my-cluster" })).toBe(
    "dftstream submit job.inp --cluster my-cluster",
  );
  expect(submitCommand({ fileName: "job.inp", cluster: "my-cluster", profile: "long" })).toBe(
    "dftstream submit job.inp --cluster my-cluster --profile long",
  );
});

test("an empty cluster or profile leaves the flag out entirely", () => {
  // Emitting `--cluster ''` would override the config's default_cluster
  // with nothing, which is not what "unset" means.
  expect(submitCommand({ fileName: "job.inp", cluster: "   ", profile: "" })).toBe(
    "dftstream submit job.inp",
  );
});

test("a name that would split into two arguments is quoted", () => {
  expect(submitCommand({ fileName: "my job.inp" })).toBe("dftstream submit 'my job.inp'");
  expect(shellQuote("it's.inp")).toBe(`'it'\\''s.inp'`);
  expect(shellQuote("")).toBe("''");
  // Ordinary path characters stay unquoted so the line reads naturally.
  expect(shellQuote("../jobs/opt-freq_1.inp")).toBe("../jobs/opt-freq_1.inp");
});

test("a hostile file name cannot escape into a second command", () => {
  const quoted = submitCommand({ fileName: "x.inp; rm -rf ~" });
  expect(quoted).toBe(`dftstream submit 'x.inp; rm -rf ~'`);
});
