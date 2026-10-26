/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema, { ARTIFACT_ENCODING, ARTIFACT_KIND } from "./schema";

const modules = import.meta.glob("./**/*.ts");

const alice = { subject: "alice", issuer: "test", email: "alice@lab.edu" };

// setAll returns one id per item it wrote. An empty array means the mutation
// did not do what the test asked, which must fail here rather than propagate
// an `undefined` id into the assertions below.
function noArtifact(): never {
  throw new Error("setAll returned no artifact id");
}

async function setup() {
  const t = convexTest(schema, modules);
  const as = t.withIdentity(alice);
  const { organizationId } = await as.mutation(api.organizations.create, {
    name: "Lab",
  });
  const experimentId = await as.mutation(api.experiments.ensure, {
    name: "enc",
    organizationId,
  });
  const runId = await as.mutation(api.runs.create, {
    experimentId,
    inputText: "! B3LYP def2-SVP Opt\n*xyz 0 1\nH 0 0 0\n*\n",
  });
  return { t, as, runId };
}

// A stand-in storage blob. The bytes are irrelevant here — these tests pin how
// the ENCODING travels, not the codec (that is covered in Go).
async function storeBlob(
  t: Awaited<ReturnType<typeof setup>>["t"],
  bytes: string,
) {
  return await t.run(async (ctx) => await ctx.storage.store(new Blob([bytes])));
}

describe("artifact body encoding", () => {
  test("getContent reports the encoding the writer recorded", async () => {
    const { t, as, runId } = await setup();
    const storageId = await storeBlob(t, "(µ/ý fake zstd frame");
    const [artifactId = noArtifact()] = await as.mutation(api.artifacts.setAll, {
      runId,
      items: [
        {
          name: "big.out",
          path: "/host/big.out",
          kind: ARTIFACT_KIND.OUTPUT,
          sizeBytes: 400000,
          mtime: 1,
          contentText: "PLAIN PREVIEW",
          storageId,
          encoding: ARTIFACT_ENCODING.ZSTD,
          storageBytes: 51234,
        },
      ],
    });

    const content = await as.query(api.artifacts.getContent, { artifactId });
    expect(content).toMatchObject({
      encoding: ARTIFACT_ENCODING.ZSTD,
      storageBytes: 51234,
    });
  });

  test("the inline preview is never encoded, whatever the blob is", async () => {
    const { t, as, runId } = await setup();
    const storageId = await storeBlob(t, "encoded body");
    const [artifactId = noArtifact()] = await as.mutation(api.artifacts.setAll, {
      runId,
      items: [
        {
          name: "big.out",
          path: "/host/big.out",
          kind: ARTIFACT_KIND.OUTPUT,
          sizeBytes: 400000,
          mtime: 1,
          contentText: "ORCA TERMINATED NORMALLY",
          storageId,
          encoding: ARTIFACT_ENCODING.ZSTD,
        },
      ],
    });
    // The stored row keeps its inline preview as plain text for search and
    // preview, whatever the blob's encoding.
    const row = await t.run(async (ctx) => await ctx.db.get(artifactId));
    expect(row?.contentText).toBe("ORCA TERMINATED NORMALLY");
    // sizeBytes stays the size of the chemist's file, not the blob's.
    expect(row?.sizeBytes).toBe(400000);
  });

  test("an artifact written before compression existed reads as identity", async () => {
    const { t, as, runId } = await setup();
    const storageId = await storeBlob(t, "plain old body");
    // No encoding field at all — exactly what every pre-compression row and
    // every UI-side upload looks like.
    const [artifactId = noArtifact()] = await as.mutation(api.artifacts.setAll, {
      runId,
      items: [
        {
          name: "legacy.out",
          path: "/host/legacy.out",
          kind: ARTIFACT_KIND.OUTPUT,
          sizeBytes: 99,
          mtime: 1,
          storageId,
        },
      ],
    });
    const content = await as.query(api.artifacts.getContent, { artifactId });
    expect(content).toMatchObject({ encoding: ARTIFACT_ENCODING.IDENTITY });
    expect((content as { storageBytes?: number }).storageBytes).toBeUndefined();
  });

  test("inline-only artifacts carry no encoding to decode", async () => {
    const { t, as, runId } = await setup();
    const [artifactId = noArtifact()] = await as.mutation(api.artifacts.setAll, {
      runId,
      items: [
        {
          name: "small.inp",
          path: "/host/small.inp",
          kind: ARTIFACT_KIND.INPUT,
          sizeBytes: 5,
          mtime: 1,
          contentText: "hello",
        },
      ],
    });
    const content = await as.query(api.artifacts.getContent, { artifactId });
    expect(content).toEqual({ contentText: "hello", truncated: false });
  });

  test("storage-backed vibmodes report their encoding too", async () => {
    const { t, as, runId } = await setup();
    const encodedId = await storeBlob(t, "encoded vib body");
    const legacyId = await storeBlob(t, "plain vib body");
    await as.mutation(api.artifacts.setAll, {
      runId,
      items: [
        {
          name: "job.v006.xyz",
          path: "/host/job.v006.xyz",
          kind: ARTIFACT_KIND.VIBMODE,
          sizeBytes: 40000,
          mtime: 1,
          storageId: encodedId,
          encoding: ARTIFACT_ENCODING.ZSTD,
        },
        {
          name: "job.v007.xyz",
          path: "/host/job.v007.xyz",
          kind: ARTIFACT_KIND.VIBMODE,
          sizeBytes: 40000,
          mtime: 1,
          storageId: legacyId,
        },
      ],
    });
    const vibs = await as.query(api.artifacts.getVibModesForRun, { runId });
    const byName = Object.fromEntries(vibs.map((v) => [v.name, v]));
    expect(byName["job.v006.xyz"]?.encoding).toBe(ARTIFACT_ENCODING.ZSTD);
    expect(byName["job.v007.xyz"]?.encoding).toBe(ARTIFACT_ENCODING.IDENTITY);
  });

  test("an encoding this deployment cannot decode is rejected at the door", async () => {
    const { t, as, runId } = await setup();
    const storageId = await storeBlob(t, "brotli body");
    await expect(
      as.mutation(api.artifacts.setAll, {
        runId,
        items: [
          {
            name: "future.out",
            path: "/host/future.out",
            kind: ARTIFACT_KIND.OUTPUT,
            sizeBytes: 10,
            mtime: 1,
            storageId,
            // Storing a body we could never read back is worse than refusing
            // the write, so the column is a closed union.
            encoding: "brotli" as never,
          },
        ],
      }),
    ).rejects.toThrow();
  });
});
