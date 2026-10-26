import { useMemo } from "react";
import { useDataSource } from "../data/DataSource";
import { PARSERS, type ParseKind, type ParseResult } from "../workers/parsers";

export interface ParsedArtifact<K extends ParseKind> {
  data: ParseResult<K> | null;
  loading: boolean;
  error: boolean;
  bytesLoaded: number;
  totalBytes?: number;
}

// NOTE: parsing currently runs on the main thread. The parsers are isolated in
// the PARSERS registry (a worker-safe, React-free module) so they can be moved
// into a Web Worker once the build emits one — Bun 1.3.x does not yet rewrite
// `new Worker(new URL(...))` references in web builds, so a worker would 404 in
// production. Streaming the download (below) already keeps the fetch off the
// critical path; the parse is the remaining main-thread cost.

// useWorkerParse parses an already-in-hand text. Use this when a component also
// needs the raw text (so it streams once via useArtifactFullText and feeds that
// text here, avoiding a second download).
export function useWorkerParse<K extends ParseKind>(
  kind: K,
  text: string | undefined,
): { data: ParseResult<K> | null; loading: boolean; error: boolean } {
  return useMemo(() => {
    if (text === undefined) return { data: null, loading: false, error: false };
    try {
      const fn = PARSERS[kind] as (t: string) => ParseResult<K>;
      return { data: fn(text), loading: false, error: false };
    } catch (err) {
      console.error("artifact parse failed", err);
      return { data: null, loading: false, error: true };
    }
  }, [kind, text]);
}

// useParsedArtifact streams an artifact body to completion, then parses it.
// Returns the parsed result plus download progress so callers can show a
// loading state on large files.
export function useParsedArtifact<K extends ParseKind>(
  artifactId: string | null,
  kind: K,
): ParsedArtifact<K> {
  const ds = useDataSource();
  const stream = ds.useArtifactFullText(artifactId);
  const parsed = useWorkerParse(kind, stream.fullText);
  return {
    data: parsed.data,
    loading: stream.loading,
    error: stream.error === true || parsed.error,
    bytesLoaded: stream.bytesLoaded,
    totalBytes: stream.totalBytes,
  };
}
