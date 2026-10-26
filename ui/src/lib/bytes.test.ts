import { describe, expect, test } from "bun:test";
import { formatBytes } from "./bytes";

describe("formatBytes", () => {
  test("buckets B / KB / MB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024 + 200 * 1024)).toBe("3.2 MB");
  });

  test("honours the decimals option", () => {
    expect(formatBytes(128 * 1024 * 1024, { decimals: 0 })).toBe("128 MB");
    expect(formatBytes(1536, { decimals: 0 })).toBe("2 KB");
  });
});
