import { afterEach, describe, expect, test } from "bun:test";
import {
  ARTIFACT_ENCODING,
  fetchArtifactText,
  resolveArtifactEncoding,
  streamArtifactText,
} from "./streamArtifact";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// makeResponse builds a minimal fetch Response whose body streams the given
// byte chunks one read() at a time, mirroring how a real network body arrives.
function makeResponse(
  chunks: Uint8Array[],
  opts: { ok?: boolean; status?: number; contentLength?: number; noBody?: boolean } = {},
): Response {
  const { ok = true, status = 200, contentLength, noBody = false } = opts;
  const headers = new Map<string, string>();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));

  let i = 0;
  const body = noBody
    ? null
    : {
        getReader() {
          return {
            read() {
              if (i < chunks.length) {
                return Promise.resolve({ done: false, value: chunks[i++] });
              }
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };

  const full = chunks.reduce((acc, c) => acc + new TextDecoder().decode(c), "");
  const flat = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    flat.set(c, at);
    at += c.byteLength;
  }
  return {
    ok,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body,
    text: () => Promise.resolve(full),
    arrayBuffer: () => Promise.resolve(flat.buffer.slice(0) as ArrayBuffer),
  } as unknown as Response;
}

function collect() {
  const pieces: string[] = [];
  const loaded: number[] = [];
  let total: number | undefined = -1 as unknown as undefined;
  return {
    pieces,
    loaded,
    get total() {
      return total;
    },
    cb: {
      onChunk: (piece: string, bytesLoaded: number) => {
        pieces.push(piece);
        loaded.push(bytesLoaded);
      },
      onTotal: (t: number | undefined) => {
        total = t;
      },
    },
  };
}

describe("streamArtifactText", () => {
  test("concatenates streamed chunks and reports cumulative bytes", async () => {
    const enc = new TextEncoder();
    const chunks = [enc.encode("hello "), enc.encode("world"), enc.encode("!")];
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse(chunks, { contentLength: 12 }))) as unknown as typeof fetch;

    const sink = collect();
    await streamArtifactText("http://x/blob", sink.cb);

    expect(sink.pieces.join("")).toBe("hello world!");
    expect(sink.total).toBe(12);
    // bytesLoaded is cumulative and ends at the full byte length.
    expect(sink.loaded[sink.loaded.length - 1]).toBe(12);
    expect(sink.loaded).toEqual([6, 11, 12]);
  });

  test("decodes a multi-byte char split across a chunk boundary", async () => {
    // "é" is 0xC3 0xA9; split the two bytes across two reads.
    const chunks = [new Uint8Array([0xc3]), new Uint8Array([0xa9, 0x21])]; // é!
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse(chunks))) as unknown as typeof fetch;

    const sink = collect();
    await streamArtifactText("http://x/blob", sink.cb);

    expect(sink.pieces.join("")).toBe("é!");
  });

  test("falls back to res.text() when the body is not streamable", async () => {
    const enc = new TextEncoder();
    globalThis.fetch = (() =>
      Promise.resolve(
        makeResponse([enc.encode("whole body")], { noBody: true }),
      )) as unknown as typeof fetch;

    const sink = collect();
    await streamArtifactText("http://x/blob", sink.cb);

    expect(sink.pieces.join("")).toBe("whole body");
    expect(sink.loaded[sink.loaded.length - 1]).toBe(10);
  });

  test("reports undefined total when Content-Length is absent", async () => {
    const enc = new TextEncoder();
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse([enc.encode("abc")]))) as unknown as typeof fetch;

    const sink = collect();
    await streamArtifactText("http://x/blob", sink.cb);
    expect(sink.total).toBeUndefined();
  });

  test("throws on a non-ok response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse([], { ok: false, status: 404 }))) as unknown as typeof fetch;

    const sink = collect();
    await expect(streamArtifactText("http://x/blob", sink.cb)).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

// --- zstd-encoded bodies ---------------------------------------------------
//
// The wrapper stores artifact bodies as a single zstd frame. These tests feed
// real zstd bytes (Bun's own encoder, independent of the fzstd decoder under
// test) through the same transport-chunking mock as above.

function zstd(text: string): Uint8Array {
  return new Uint8Array(Bun.zstdCompressSync(Buffer.from(text, "utf-8"), { level: 9 }));
}

// splitBytes cuts a buffer into n roughly equal transport chunks, so the
// decoder is exercised across frame-internal boundaries.
function splitBytes(buf: Uint8Array, n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const step = Math.ceil(buf.byteLength / n);
  for (let i = 0; i < buf.byteLength; i += step) {
    out.push(buf.subarray(i, Math.min(i + step, buf.byteLength)));
  }
  return out;
}

describe("streamArtifactText with a zstd body", () => {
  test("decodes a frame delivered across several transport chunks", async () => {
    const body = "ORCA TERMINATED NORMALLY\n".repeat(400) + "FINAL SINGLE POINT ENERGY -76.02\n";
    const encoded = zstd(body);
    globalThis.fetch = (() =>
      Promise.resolve(
        makeResponse(splitBytes(encoded, 7), { contentLength: encoded.byteLength }),
      )) as unknown as typeof fetch;

    const sink = collect();
    await streamArtifactText("http://x/blob", { ...sink.cb, encoding: "zstd" });

    expect(sink.pieces.join("")).toBe(body);
    // Progress is measured in TRANSPORT bytes so it lines up with
    // Content-Length, which is the compressed size.
    expect(sink.total).toBe(encoded.byteLength);
    expect(sink.loaded[sink.loaded.length - 1]).toBe(encoded.byteLength);
    expect(encoded.byteLength).toBeLessThan(body.length);
  });

  test("round-trips a real ORCA output byte for byte", async () => {
    const raw = await Bun.file(
      new URL("../../../example_logs/water_hf_def2svp_opt_freq.out", import.meta.url).pathname,
    ).text();
    const encoded = zstd(raw);
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse(splitBytes(encoded, 23)))) as unknown as typeof fetch;

    const sink = collect();
    await streamArtifactText("http://x/blob", { ...sink.cb, encoding: "zstd" });
    expect(sink.pieces.join("")).toBe(raw);
  });

  test("decodes multi-byte characters that straddle decoded pieces", async () => {
    const body = "μ = 1.85 D · ΔE‡ = 12.3 kcal/mol\n".repeat(300);
    const encoded = zstd(body);
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse(splitBytes(encoded, 11)))) as unknown as typeof fetch;

    const sink = collect();
    await streamArtifactText("http://x/blob", { ...sink.cb, encoding: "zstd" });
    expect(sink.pieces.join("")).toBe(body);
  });

  test("decodes a zstd body when the response is not streamable", async () => {
    const body = "SCF CONVERGED\n".repeat(100);
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse([zstd(body)], { noBody: true }))) as unknown as typeof fetch;

    const sink = collect();
    await streamArtifactText("http://x/blob", { ...sink.cb, encoding: "zstd" });
    expect(sink.pieces.join("")).toBe(body);
  });

  test("a truncated frame errors instead of yielding a short body", async () => {
    const encoded = zstd("ORCA TERMINATED NORMALLY\n".repeat(500));
    const cut = encoded.subarray(0, encoded.byteLength - 12);
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse([cut]))) as unknown as typeof fetch;

    const sink = collect();
    await expect(
      streamArtifactText("http://x/blob", { ...sink.cb, encoding: "zstd" }),
    ).rejects.toThrow();
  });
});

describe("artifact encoding compatibility", () => {
  test("an artifact with no encoding field reads as plain text", async () => {
    // Every artifact stored before compression existed looks like this.
    const enc = new TextEncoder();
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse([enc.encode("legacy body")]))) as unknown as typeof fetch;

    const sink = collect();
    await streamArtifactText("http://x/blob", sink.cb); // no encoding at all
    expect(sink.pieces.join("")).toBe("legacy body");

    const sink2 = collect();
    await streamArtifactText("http://x/blob", { ...sink2.cb, encoding: null });
    expect(sink2.pieces.join("")).toBe("legacy body");

    const sink3 = collect();
    await streamArtifactText("http://x/blob", { ...sink3.cb, encoding: "identity" });
    expect(sink3.pieces.join("")).toBe("legacy body");
  });

  test("an encoding this build cannot decode fails loudly, without fetching", async () => {
    let fetched = false;
    globalThis.fetch = (() => {
      fetched = true;
      return Promise.resolve(makeResponse([]));
    }) as unknown as typeof fetch;

    const sink = collect();
    await expect(
      streamArtifactText("http://x/blob", { ...sink.cb, encoding: "brotli" }),
    ).rejects.toThrow(/cannot decode/);
    expect(fetched).toBe(false);
  });

  test("resolveArtifactEncoding treats absence as identity and rejects the unknown", () => {
    expect(resolveArtifactEncoding(undefined)).toBe(ARTIFACT_ENCODING.identity);
    expect(resolveArtifactEncoding(null)).toBe(ARTIFACT_ENCODING.identity);
    expect(resolveArtifactEncoding("")).toBe(ARTIFACT_ENCODING.identity);
    expect(resolveArtifactEncoding("identity")).toBe(ARTIFACT_ENCODING.identity);
    expect(resolveArtifactEncoding("zstd")).toBe(ARTIFACT_ENCODING.zstd);
    expect(() => resolveArtifactEncoding("gzip")).toThrow(/cannot decode/);
  });
});

describe("fetchArtifactText", () => {
  test("returns the whole decoded body for both encodings", async () => {
    const body = "ORBITAL ENERGIES\n".repeat(200);
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse(splitBytes(zstd(body), 5)))) as unknown as typeof fetch;
    expect(await fetchArtifactText("http://x/blob", { encoding: "zstd" })).toBe(body);

    const enc = new TextEncoder();
    globalThis.fetch = (() =>
      Promise.resolve(makeResponse([enc.encode(body)]))) as unknown as typeof fetch;
    expect(await fetchArtifactText("http://x/blob")).toBe(body);
  });
});
