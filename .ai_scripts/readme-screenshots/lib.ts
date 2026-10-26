/**
 * Shared helpers for the README capture scripts: local Convex calls, waiting,
 * child processes and GIF encoding. LOCAL backend only (127.0.0.1:3210).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

export const CONVEX = "http://127.0.0.1:3210"; // local only

export async function q(path: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${CONVEX}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await res.json()) as { status?: string; value?: unknown; errorMessage?: string };
  if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage}`);
  return body.value;
}

export async function m(path: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${CONVEX}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await res.json()) as { status?: string; value?: unknown; errorMessage?: string };
  if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage}`);
  return body.value;
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined>, timeoutMs = 60_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function start(cmd: string, args: string[], env: Record<string, string>, log: string): ChildProcess {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const sink = Bun.file(log).writer();
  child.stdout?.on("data", (d) => sink.write(d));
  child.stderr?.on("data", (d) => sink.write(d));
  child.on("exit", (code) => {
    sink.end();
    console.log(`  (${cmd.split("/").pop()} exited ${code})`);
  });
  return child;
}

export async function writeGif(frames: Buffer[], file: string, playMs: number): Promise<void> {
  const rgba = await Promise.all(
    frames.map(async (png) => {
      const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
    }),
  );
  const { width, height } = rgba[0]!;
  // One palette sampled from every 4th frame: stable colours, bounded memory.
  const sample = rgba.filter((_, i) => i % 4 === 0);
  const merged = new Uint8ClampedArray(sample.reduce((n, f) => n + f.data.length, 0));
  let at = 0;
  for (const f of sample) {
    merged.set(f.data, at);
    at += f.data.length;
  }
  const palette = quantize(merged, 128, { format: "rgb565" });
  const gif = GIFEncoder();
  rgba.forEach((f, i) => {
    const last = i === rgba.length - 1;
    gif.writeFrame(applyPalette(f.data, palette, "rgb565"), width, height, {
      palette,
      delay: last ? 2500 : playMs,
      ...(i === 0 ? { repeat: 0 } : {}),
    });
  });
  gif.finish();
  await writeFile(file, gif.bytes());
  console.log(`  -> ${file}  ${(gif.bytes().byteLength / 1024).toFixed(0)} KB  ${width}x${height}  ${rgba.length} frames`);
}
