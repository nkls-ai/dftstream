// Export helpers for the StructureViewer: snapshot the current frame as a
// PNG, or record the trajectory / turntable animation as a video (MP4 where
// the browser supports it, otherwise WebM).
//
// The 3Dmol viewer is created with preserveDrawingBuffer:true, so reading the
// WebGL canvas via toDataURL/toBlob and feeding captureStream() both work
// reliably as long as we render right before we read.

/** A renderable sequence of animation frames. `seek(i)` must draw frame i to
 *  the canvas (i.e. call viewer.render() itself) before resolving. */
export interface FrameSequence {
  /** Number of distinct frames to render (>= 1). */
  count: number;
  /** Render frame i onto the live canvas. May be async (setFrame returns a
   *  promise once frames are loaded). */
  seek: (i: number) => void | Promise<void>;
}

export interface ExportProgress {
  /** 0..1 completion fraction. */
  fraction: number;
}

export type ProgressCb = (p: ExportProgress) => void;

// Blob download lives in lib/download.ts; re-exported here so viewer
// consumers keep a single import site for export helpers.
export { downloadBlob } from "./download";

/** Snapshot the current canvas as a PNG blob. */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface VideoMime {
  mimeType: string;
  ext: "mp4" | "webm";
}

/** Pick the best supported MediaRecorder container, preferring MP4. Returns
 *  null when MediaRecorder / canvas recording isn't available at all. */
export function pickVideoMime(): VideoMime | null {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates: VideoMime[] = [
    { mimeType: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
    { mimeType: "video/mp4", ext: "mp4" },
    { mimeType: "video/webm;codecs=vp9", ext: "webm" },
    { mimeType: "video/webm;codecs=vp8", ext: "webm" },
    { mimeType: "video/webm", ext: "webm" },
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
    } catch {
      // isTypeSupported can throw on malformed strings in some engines — skip.
    }
  }
  return null;
}

export function canRecordVideo(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof (HTMLCanvasElement.prototype as { captureStream?: unknown })
      .captureStream === "function" &&
    pickVideoMime() !== null
  );
}

export interface VideoOptions {
  fps?: number;
  /** Hold the final frame this many ms before stopping (avoids truncated tail). */
  tailMs?: number;
  onProgress?: ProgressCb;
}

/** Record a FrameSequence to a video Blob by playing it back in real time
 *  while MediaRecorder captures the canvas stream. */
export async function recordVideo(
  canvas: HTMLCanvasElement,
  seq: FrameSequence,
  mime: VideoMime,
  opts: VideoOptions = {},
): Promise<Blob> {
  const fps = opts.fps ?? 12;
  const tailMs = opts.tailMs ?? 300;
  const frameMs = 1000 / fps;

  const stream = (
    canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }
  ).captureStream(fps);
  const recorder = new MediaRecorder(stream, { mimeType: mime.mimeType });
  const chunks: BlobPart[] = [];

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = () =>
      reject(new Error("MediaRecorder failed during capture"));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime.mimeType }));
  });

  recorder.start();
  try {
    // Render frame 0 first and let the stream warm up.
    await seq.seek(0);
    await sleep(frameMs);
    opts.onProgress?.({ fraction: 1 / seq.count });
    for (let i = 1; i < seq.count; i++) {
      await seq.seek(i);
      await sleep(frameMs);
      opts.onProgress?.({ fraction: (i + 1) / seq.count });
    }
    await sleep(tailMs);
  } finally {
    recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
  }
  return done;
}
