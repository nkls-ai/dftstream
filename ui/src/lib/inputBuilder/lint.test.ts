import { expect, test } from "bun:test";
import { LintSeverity, hasErrors, keywordTokens, lintInput } from "./lint";

const codes = (text: string, opts = {}) => lintInput(text, opts).map((f) => f.code);

test("an impossible charge/multiplicity pair is an error", () => {
  // CH3 radical (9 electrons) cannot be a singlet.
  const text = `! r2SCAN-3c Opt Freq
%pal nprocs 8 end
%maxcore 3000
* xyz 0 1
C 0 0 0
H 1.09 0 0
H -0.55 0.94 0
H -0.55 -0.94 0
*
`;
  const findings = lintInput(text);
  expect(findings[0]?.severity).toBe(LintSeverity.Error);
  expect(findings[0]?.code).toBe("charge-mult-parity");
  expect(findings[0]?.message).toContain("9 electrons");
  expect(hasErrors(findings)).toBe(true);
});

test("the same system as a doublet passes", () => {
  const text = `! r2SCAN-3c Opt Freq
%pal nprocs 8 end
%maxcore 3000
* xyz 0 2
C 0 0 0
H 1.09 0 0
H -0.55 0.94 0
H -0.55 -0.94 0
*
`;
  expect(codes(text)).toEqual([]);
});

test("a charged, closed-shell system passes", () => {
  const text = `! B3LYP def2-SVP
%pal nprocs 4 end
%maxcore 2000
* xyz 1 1
N 0 0 0
H 1.02 0 0
H -0.34 0.96 0
H -0.34 -0.48 0.83
H 0 0 1.02
*
`;
  expect(codes(text)).toEqual([]);
});

test("multiplicity 0 is refused outright", () => {
  // The resource infos still come along; the parity check is the point.
  expect(codes("! HF\n* xyz 0 0\nH 0 0 0\n*\n")).toContain("mult-invalid");
});

test("memory past 75% of RAM warns", () => {
  const text = "! HF\n%pal nprocs 16 end\n%maxcore 8000\n* xyz 0 1\nH 0 0 0\nH 0 0 0.74\n*\n";
  const findings = lintInput(text, { totalRAMMB: 64 * 1024 });
  const mem = findings.find((f) => f.code === "maxcore-exceeds-ram");
  expect(mem?.severity).toBe(LintSeverity.Warn);
  expect(mem?.message).toContain("125.0 GB requested");
  // Comfortably inside the budget: no finding.
  expect(codes("! HF\n%pal nprocs 8 end\n%maxcore 3000\n* xyz 0 1\nH 0 0 0\nH 0 0 0.74\n*\n", {
    totalRAMMB: 64 * 1024,
  })).toEqual([]);
});

test("the machine profile's core count catches an oversubscribed %pal", () => {
  const text = "! HF\n%pal nprocs 32 end\n%maxcore 1000\n* xyz 0 1\nH 0 0 0\nH 0 0 0.74\n*\n";
  // Workstation-shaped profile: 16 cores, 64 GB.
  const findings = lintInput(text, { totalCores: 16, totalRAMMB: 64 * 1024 });
  const cores = findings.find((f) => f.code === "nprocs-exceeds-cores");
  expect(cores?.severity).toBe(LintSeverity.Warn);
  expect(cores?.message).toContain("32");
  expect(cores?.message).toContain("16 cores");
  // Fitting the machine, and no machine selected at all, both stay quiet.
  expect(codes(text, { totalCores: 32 })).toEqual([]);
  expect(codes(text, {})).toEqual([]);
});

test("missing resources are info, not noise", () => {
  const found = codes("! HF\n* xyz 0 1\nH 0 0 0\nH 0 0 0.74\n*\n");
  expect(found).toEqual(["no-pal", "no-maxcore"]);
});

test("a keyword typo is caught, an unknown-but-plausible keyword is not", () => {
  const typo = lintInput("! B3LYP Otp def2-SVP\n%pal nprocs 2 end\n%maxcore 1000\n* xyz 0 1\nH 0 0 0\nH 0 0 0.74\n*\n");
  expect(typo[0]?.code).toBe("keyword-typo");
  expect(typo[0]?.message).toContain("OPT");
  // A real ORCA keyword we simply do not model must stay silent.
  expect(codes("! B3LYP def2-SVP SomeExoticKeyword\n%pal nprocs 2 end\n%maxcore 1000\n* xyz 0 1\nH 0 0 0\nH 0 0 0.74\n*\n"))
    .toEqual([]);
});

test("non-ASCII characters are an error with the culprit named", () => {
  const text = "! B3LYP def2–SVP\n%pal nprocs 2 end\n%maxcore 1000\n* xyz 0 1\nH 0 0 0\nH 0 0 0.74\n*\n";
  const finding = lintInput(text).find((f) => f.code === "non-ascii");
  expect(finding?.severity).toBe(LintSeverity.Error);
  expect(finding?.message).toContain("en dash");
  expect(finding?.message).toContain("U+2013");
});

test("an xyzfile reference is checked against the files the builder ships", () => {
  const text = "! HF\n%pal nprocs 2 end\n%maxcore 1000\n* xyzfile 0 1 start.xyz\n";
  expect(codes(text, { availableFiles: ["start.xyz"] })).toEqual([]);
  const missing = lintInput(text, { availableFiles: ["other.xyz"] });
  expect(missing[0]?.code).toBe("xyzfile-missing");
});

test("an input with no coordinates at all warns", () => {
  expect(codes("! B3LYP def2-SVP\n%pal nprocs 2 end\n%maxcore 1000\n")).toEqual(["no-coords"]);
});

test("keywordTokens reads every ! line and drops comments", () => {
  expect(keywordTokens("# note\n! B3LYP def2-SVP # inline comment\n! TightSCF\n* xyz 0 1\n")).toEqual([
    "B3LYP",
    "def2-SVP",
    "TightSCF",
  ]);
});
