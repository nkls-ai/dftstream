// Streams an artifact body from the backend's authenticated /api/artifact
// route (the `bodyUrl` returned by artifacts.getContent). Reads the response
// as a byte stream and decodes incrementally so the caller can render a
// multi-MB file progressively instead of waiting for the whole download.
//
// Every request carries the caller's JWT (see lib/authToken.ts): the route
// re-runs the org-membership gate per request, which is what replaced the old
// non-expiring signed storage URLs. The route doesn't support HTTP Range
// requests, so this streams the full body once (no random-access windowing) —
// which is all the text viewer and the parsers need.
//
// Bodies written by the Go wrapper are zstd-encoded (see
// wrapper/internal/artifacts/compress.go). The encoding is read off the
// artifact row, never sniffed from the bytes, and the decoder is imported
// lazily so it only costs a chunk download when a compressed body is opened.

import { getAuthToken } from "./authToken";
import { createZstdByteStream, decompressZstdBytes } from "./decompressZstd";

// How an artifact's storage blob is encoded. Mirrors ARTIFACT_ENCODING in
// db/convex/schema.ts, which is the source of truth.
export const ARTIFACT_ENCODING = {
  identity: "identity",
  zstd: "zstd",
} as const;

export type ArtifactEncoding =
  (typeof ARTIFACT_ENCODING)[keyof typeof ARTIFACT_ENCODING];

// resolveArtifactEncoding turns the wire value into an encoding this build can
// decode.
//
// An absent value means identity: that is what every artifact stored before
// compression existed looks like, and those must keep reading forever. An
// unrecognized value means the body was written by something newer than us —
// we throw rather than hand back bytes we cannot correctly decode.
export function resolveArtifactEncoding(
  raw: string | null | undefined,
): ArtifactEncoding {
  if (raw === null || raw === undefined || raw === "") {
    return ARTIFACT_ENCODING.identity;
  }
  if (raw === ARTIFACT_ENCODING.identity || raw === ARTIFACT_ENCODING.zstd) {
    return raw;
  }
  throw new Error(
    `artifact body uses encoding "${raw}", which this version of DFTStream cannot decode`,
  );
}

export interface StreamCallbacks {
  // Called per decoded piece of TEXT with the cumulative TRANSPORT bytes read
  // so far. The two counts differ under compression on purpose: progress is
  // measured against Content-Length, which is also transport bytes.
  onChunk: (piece: string, bytesLoaded: number) => void;
  // Called once with the Content-Length total, if the server reports it.
  onTotal?: (total: number | undefined) => void;
  signal?: AbortSignal;
  // The `encoding` recorded on the artifact row. Absent means identity.
  encoding?: string | null;
}

export async function streamArtifactText(
  url: string,
  cb: StreamCallbacks,
): Promise<void> {
  // Resolve before fetching: an encoding we cannot decode is a hard error, and
  // there is no point downloading megabytes we would have to throw away.
  const encoding = resolveArtifactEncoding(cb.encoding);

  // Fetched fresh per request — tokens rotate. Null (auth disabled / signed
  // out) sends the request bare; the auth-disabled backend accepts that, and
  // an auth-enabled one answers 401, surfaced as the stream error below.
  const token = await getAuthToken();
  const res = await fetch(url, {
    signal: cb.signal,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`artifact fetch failed: HTTP ${res.status}`);

  const lenHeader = res.headers.get("Content-Length");
  cb.onTotal?.(lenHeader ? Number(lenHeader) : undefined);

  if (!res.body) {
    // Environment without streaming bodies — fall back to a single read.
    if (encoding === ARTIFACT_ENCODING.zstd) {
      const raw = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder("utf-8").decode(await decompressZstdBytes(raw));
      cb.onChunk(text, raw.byteLength);
      return;
    }
    const text = await res.text();
    cb.onChunk(text, new TextEncoder().encode(text).length);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;

  if (encoding === ARTIFACT_ENCODING.zstd) {
    // The decoder chunk is fetched here and nowhere else in the app.
    const pending: string[] = [];
    const zstd = await createZstdByteStream((data, final) => {
      const piece = decoder.decode(data, { stream: !final });
      if (piece) pending.push(piece);
    });
    const drain = () => {
      for (const piece of pending) cb.onChunk(piece, bytes);
      pending.length = 0;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      // A corrupt or truncated frame throws out of push(); it propagates to the
      // caller instead of silently producing a short body.
      zstd.push(value);
      drain();
    }
    zstd.push(new Uint8Array(0), true); // close the frame; validates the checksum
    drain();
    const tail = decoder.decode(); // flush any trailing multi-byte sequence
    if (tail) cb.onChunk(tail, bytes);
    return;
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    const piece = decoder.decode(value, { stream: true });
    if (piece) cb.onChunk(piece, bytes);
  }
  const tail = decoder.decode(); // flush any trailing multi-byte sequence
  if (tail) cb.onChunk(tail, bytes);
}

// fetchArtifactText reads a whole body as text, applying the same encoding
// rules as the streaming path. For consumers that parse the complete file and
// have no use for progressive updates.
export async function fetchArtifactText(
  url: string,
  opts: { encoding?: string | null; signal?: AbortSignal } = {},
): Promise<string> {
  const pieces: string[] = [];
  await streamArtifactText(url, {
    encoding: opts.encoding,
    signal: opts.signal,
    onChunk: (piece) => {
      pieces.push(piece);
    },
  });
  return pieces.join("");
}
