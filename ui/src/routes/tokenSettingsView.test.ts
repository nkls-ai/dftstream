import { describe, expect, test } from "bun:test";
import type { CliSessionInfo, MachineTokenInfo } from "../data/DataSource";
import {
  expiresLabel,
  lastUsedLabel,
  sessionOrgLabel,
  sortCliSessions,
  sortMachineTokens,
} from "./tokenSettingsView";

let seq = 0;
function mkToken(createdAt: number, revokedAt: number | null = null): MachineTokenInfo {
  seq += 1;
  return { tokenId: `t${seq}`, name: `tok-${seq}`, createdAt, lastUsedAt: null, revokedAt };
}

function mkSession(createdAt: number, organizationId: string | null = "org1"): CliSessionInfo {
  seq += 1;
  return { linkId: `l${seq}`, organizationId, createdAt, lastUsedAt: null, expiresAt: null };
}

describe("sortMachineTokens", () => {
  test("active first (newest on top), revoked last; input not mutated", () => {
    const revokedOld = mkToken(10, 500);
    const activeOld = mkToken(20);
    const activeNew = mkToken(300);
    const revokedNew = mkToken(400, 900);
    const input = [revokedOld, activeOld, revokedNew, activeNew];
    const inputCopy = [...input];
    const sorted = sortMachineTokens(input);
    expect(sorted.map((t) => t.tokenId)).toEqual([
      activeNew.tokenId,
      activeOld.tokenId,
      revokedNew.tokenId,
      revokedOld.tokenId,
    ]);
    expect(input).toEqual(inputCopy);
  });
});

describe("lastUsedLabel", () => {
  test("never-exchanged tokens say so; used ones get a relative time", () => {
    expect(lastUsedLabel(null)).toBe("never used");
    const now = 1_000_000_000_000;
    const label = lastUsedLabel(now - 5 * 60 * 1000, now);
    expect(label.startsWith("used ")).toBe(true);
    expect(label).toContain("ago");
  });
});

describe("sessionOrgLabel", () => {
  const orgs = [{ organizationId: "org-abcdef1234", name: "Lab A" }];
  test("resolves a known org to its name", () => {
    expect(sessionOrgLabel("org-abcdef1234", orgs)).toBe("Lab A");
  });
  test("shortens an org the user no longer belongs to", () => {
    expect(sessionOrgLabel("org-unknown-xyz", orgs)).toBe("org-unkn…");
  });
  test("dashes a legacy unscoped session", () => {
    expect(sessionOrgLabel(null, orgs)).toBe("—");
  });
});

describe("expiresLabel", () => {
  const now = 1_000_000_000_000;
  const HOUR = 60 * 60 * 1000;
  test("days above 48h, hours below, expired at/after the deadline", () => {
    expect(expiresLabel(now + 30 * 24 * HOUR, now)).toBe("expires in 30d");
    expect(expiresLabel(now + 47 * HOUR, now)).toBe("expires in 47h");
    expect(expiresLabel(now + 30 * 60 * 1000, now)).toBe("expires in 1h");
    expect(expiresLabel(now, now)).toBe("expired");
    expect(expiresLabel(now - 1, now)).toBe("expired");
  });
});

describe("sortCliSessions", () => {
  test("newest first, input not mutated", () => {
    const a = mkSession(100);
    const b = mkSession(300);
    const c = mkSession(200);
    const input = [a, b, c];
    const inputCopy = [...input];
    expect(sortCliSessions(input).map((s) => s.linkId)).toEqual([
      b.linkId,
      c.linkId,
      a.linkId,
    ]);
    expect(input).toEqual(inputCopy);
  });
});
