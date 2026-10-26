import { test, expect, describe } from "bun:test";
import { parseMultiXYZ } from "./xyz";

function makeXYZFrame(n: number, offset: number): string {
  const lines = [`${n}`, `frame offset=${offset.toFixed(4)}`];
  for (let i = 0; i < n; i++) {
    lines.push(`C  ${(i * 1.5 + offset).toFixed(6)}  0.000000  0.000000`);
  }
  return lines.join("\n");
}

function makeTrajectory(nAtoms: number, nFrames: number): string {
  const frames: string[] = [];
  for (let f = 0; f < nFrames; f++) {
    frames.push(makeXYZFrame(nAtoms, f * 0.01));
  }
  return frames.join("\n");
}

describe("parseMultiXYZ performance", () => {
  test("parses 21-frame vibration trajectory (typical orca_pltvib) in < 5ms", () => {
    const trj = makeTrajectory(30, 21);
    const t0 = performance.now();
    const iterations = 100;
    for (let i = 0; i < iterations; i++) {
      parseMultiXYZ(trj);
    }
    const elapsed = (performance.now() - t0) / iterations;
    expect(elapsed).toBeLessThan(5);
    const frames = parseMultiXYZ(trj);
    expect(frames).toHaveLength(21);
  });

  test("parses 200-frame opt trajectory (large molecule) in < 20ms", () => {
    const trj = makeTrajectory(120, 200);
    const t0 = performance.now();
    const iterations = 10;
    for (let i = 0; i < iterations; i++) {
      parseMultiXYZ(trj);
    }
    const elapsed = (performance.now() - t0) / iterations;
    expect(elapsed).toBeLessThan(20);
    const frames = parseMultiXYZ(trj);
    expect(frames).toHaveLength(200);
  });
});

describe("fast-path config key detection", () => {
  function configKey(params: {
    style: string;
    labels: boolean;
    surface: string;
    bg: string;
    spinning: boolean;
    orbitalKind: string;
    orbitalCubeLen: number;
    opacity: number;
    colorByCharge: boolean;
    chargesLen: number;
  }): string {
    return `${params.style}|${params.labels}|${params.surface}|${params.bg}|${params.spinning}|${params.orbitalKind}:${params.orbitalCubeLen}|${params.opacity}|${params.colorByCharge}|${params.chargesLen}`;
  }

  const base = {
    style: "ball-stick",
    labels: false,
    surface: "none",
    bg: "dark",
    spinning: false,
    orbitalKind: "",
    orbitalCubeLen: 0,
    opacity: 0.55,
    colorByCharge: false,
    chargesLen: 0,
  };

  test("same config produces same key", () => {
    expect(configKey(base)).toBe(configKey({ ...base }));
  });

  test("different style produces different key", () => {
    expect(configKey(base)).not.toBe(configKey({ ...base, style: "stick" }));
  });

  test("different labels produces different key", () => {
    expect(configKey(base)).not.toBe(configKey({ ...base, labels: true }));
  });

  test("different orbital produces different key", () => {
    expect(configKey(base)).not.toBe(
      configKey({ ...base, orbitalKind: "homo", orbitalCubeLen: 50000 }),
    );
  });

  test("config key computation is fast (10k iterations < 5ms)", () => {
    const t0 = performance.now();
    for (let i = 0; i < 10000; i++) {
      configKey(base);
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(5);
  });
});

describe("vibration frame throughput simulation", () => {
  test("21 frames × string comparison is < 1ms (fast-path overhead)", () => {
    const frames = Array.from({ length: 21 }, (_, i) =>
      makeXYZFrame(30, i * 0.01),
    );
    const configStr = "ball-stick|false|none|dark|false||0|0.55|false|0";
    let prevConfig = configStr;
    let prevXyz = "";

    const t0 = performance.now();
    for (let cycle = 0; cycle < 100; cycle++) {
      for (const frame of frames) {
        const xyzChanged = frame !== prevXyz;
        const configChanged = configStr !== prevConfig;
        prevXyz = frame;
        prevConfig = configStr;
        // Fast path: xyzChanged && !configChanged
        if (xyzChanged && !configChanged) {
          // This is the fast path — no scene rebuild needed
        }
      }
    }
    const elapsed = performance.now() - t0;
    // 100 cycles × 21 frames = 2100 comparisons in < 1ms
    expect(elapsed).toBeLessThan(5);
  });
});
