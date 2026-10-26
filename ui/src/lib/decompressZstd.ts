// Lazily-loaded zstd decoder for artifact bodies.
//
// The decoder is reached ONLY through the dynamic import below, so the bundler
// splits it into its own chunk: a session that never opens a compressed
// artifact body never downloads or parses it. Keep this the single import site
// — a static `import "fzstd"` anywhere would pull it back into the main bundle.
//
// fzstd is a pure-JS (no wasm, no dependencies) implementation, so there is no
// second network fetch for a .wasm file and nothing to instantiate.

type Fzstd = typeof import("fzstd");

let loading: Promise<Fzstd> | null = null;

function loadFzstd(): Promise<Fzstd> {
  if (!loading) {
    loading = import("fzstd").catch((err: unknown) => {
      // A failed chunk load (offline, cache miss, deploy mid-session) must not
      // poison every later attempt — drop the memo so the next open retries.
      loading = null;
      throw err instanceof Error
        ? err
        : new Error(`failed to load the zstd decoder: ${String(err)}`);
    });
  }
  return loading;
}

// Sink for decoded bytes. `final` is true on the last piece of the stream.
export type ZstdSink = (data: Uint8Array, final?: boolean) => void;

export interface ZstdByteStream {
  // Feeds compressed bytes in. Decoded output arrives synchronously on the
  // sink. Throws on a corrupt or truncated frame rather than yielding a short
  // body — a silently truncated scientific record is worse than an error.
  push(chunk: Uint8Array, final?: boolean): void;
}

// createZstdByteStream loads the decoder and wires it to `onData`. Await it
// once per body, then push transport chunks as they arrive.
export async function createZstdByteStream(onData: ZstdSink): Promise<ZstdByteStream> {
  const { Decompress } = await loadFzstd();
  const decompressor = new Decompress((data, final) => onData(data, final));
  return {
    push(chunk, final) {
      decompressor.push(chunk, final);
    },
  };
}

// decompressZstdBytes decodes a whole frame at once. Used only where the body
// could not be streamed (an environment without ReadableStream bodies).
export async function decompressZstdBytes(data: Uint8Array): Promise<Uint8Array> {
  const { decompress } = await loadFzstd();
  return decompress(data);
}
