import { useEffect, useRef, useState } from "react";
import { streamArtifactText } from "../lib/streamArtifact";
import type { ArtifactTextStream } from "./types";

export interface InlineText {
  text: string;
  truncated?: boolean;
  incomplete?: boolean;
}

/** Minimum gap between progressive line flushes while a body downloads. */
const FLUSH_INTERVAL_MS = 100;

export interface StreamedTextOptions {
  // When false, skip incremental line splitting — `lines` stays empty and only
  // `fullText` is produced on completion. Used by parse-only consumers so we
  // don't hold both a line array and the full string for a large file.
  buildLines?: boolean;
}

// useStreamedText turns a resolved artifact source into a progressive text
// stream. Exactly one of the inputs applies:
//   - resolving: the getContent query is still loading -> { loading: true }
//   - url:       storage-backed body -> stream it, growing `lines` on rAF
//   - inline:    small/legacy body already in hand -> resolve immediately
//
// encoding is how the blob at `url` is stored (see resolveArtifactEncoding);
// undefined means identity, which is what every pre-compression artifact is.
//
// streamKey is the stable identity of the url source (the artifactId — the
// authenticated bodyUrl is derived from it and the bytes behind an artifact
// id never change). The streaming effect keys on it, not on `url`, so a
// host-rewrite recomputation can never restart an in-flight stream; the
// latest url is read from a ref at fetch time.
export function useStreamedText(
  url: string | null | undefined,
  streamKey: string | null | undefined,
  encoding: string | null | undefined,
  inline: InlineText | null | undefined,
  resolving: boolean,
  opts?: StreamedTextOptions,
): ArtifactTextStream {
  const buildLines = opts?.buildLines ?? true;
  const [state, setState] = useState<ArtifactTextStream>({
    lines: [],
    loading: true,
    bytesLoaded: 0,
  });

  const inlineText = inline?.text;
  const inlineTrunc = inline?.truncated;
  const inlineIncomplete = inline?.incomplete;

  // Latest url, read inside the effect so a churned signed url is used without
  // making the effect re-run on the url string itself.
  const urlRef = useRef(url);
  urlRef.current = url;

  useEffect(() => {
    const url = urlRef.current;
    if (resolving) {
      setState({ lines: [], loading: true, bytesLoaded: 0 });
      return;
    }

    if (!url) {
      if (inlineText !== undefined) {
        setState({
          lines: buildLines ? inlineText.split("\n") : [],
          fullText: inlineText,
          loading: false,
          bytesLoaded: inlineText.length,
          truncated: inlineTrunc,
          incomplete: inlineIncomplete,
        });
      } else {
        setState({ lines: [], loading: false, bytesLoaded: 0 });
      }
      return;
    }

    // Streaming, URL-backed body.
    let cancelled = false;
    const controller = new AbortController();
    const linesAcc: string[] = [];
    const pieces: string[] = []; // used when !buildLines
    let partial = "";
    let bytes = 0;
    let total: number | undefined;
    let raf: number | null = null;

    setState({ lines: [], loading: true, bytesLoaded: 0 });

    const currentLines = () => {
      if (!buildLines) return [];
      return partial.length > 0 || linesAcc.length === 0
        ? [...linesAcc, partial]
        : [...linesAcc];
    };

    // currentLines() copies the whole accumulated line array, and it used to
    // run on every animation frame. A 300 MB .out is ~5M lines, so a fast
    // download allocated (and immediately discarded) a 5M-element array up to
    // 60 times a second — enough GC pressure to stall the tab for the whole
    // download. The frame is still the unit of scheduling, but at most one
    // flush per FLUSH_INTERVAL_MS actually copies; progress stays visibly
    // live, at a tenth of the allocation.
    let lastFlush = 0;

    const scheduleFlush = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        if (cancelled) return;
        const now = Date.now();
        if (now - lastFlush < FLUSH_INTERVAL_MS) {
          scheduleFlush();
          return;
        }
        lastFlush = now;
        setState((s) => ({
          ...s,
          lines: currentLines(),
          loading: true,
          bytesLoaded: bytes,
          totalBytes: total,
        }));
      });
    };

    streamArtifactText(url, {
      signal: controller.signal,
      encoding,
      onTotal: (t) => {
        total = t;
      },
      onChunk: (piece, loaded) => {
        if (cancelled) return;
        bytes = loaded;
        if (buildLines) {
          const combined = partial + piece;
          const segs = combined.split("\n");
          partial = segs.pop() ?? "";
          for (const seg of segs) linesAcc.push(seg);
        } else {
          pieces.push(piece);
        }
        scheduleFlush();
      },
    })
      .then(() => {
        if (cancelled) return;
        if (raf != null) {
          cancelAnimationFrame(raf);
          raf = null;
        }
        const finalLines = currentLines();
        const fullText = buildLines ? finalLines.join("\n") : pieces.join("");
        setState({
          lines: finalLines,
          fullText,
          loading: false,
          bytesLoaded: bytes,
          totalBytes: total,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A flush scheduled by the last successful chunk is still pending
        // here. Left alone it fires after this setState and writes
        // `loading: true` back over the error, so a failed download rendered
        // as a spinner that never resolved instead of an error.
        if (raf != null) {
          cancelAnimationFrame(raf);
          raf = null;
        }
        console.error("artifact stream failed", err);
        setState((s) => ({ ...s, loading: false, error: true }));
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [streamKey, encoding, resolving, inlineText, inlineTrunc, inlineIncomplete, buildLines]);

  return state;
}
