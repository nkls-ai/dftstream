import { ARTIFACT_KIND } from "../data/types";
import { formatBytes } from "./bytes";

export const UPLOAD_INLINE_PREVIEW_CHARS = 16 * 1024;
export const UPLOAD_MAX_TEXT_CHARS = 128 * 1024 * 1024;
export const UPLOAD_MAX_FILE_BYTES = 128 * 1024 * 1024;

export interface ArtifactUploadItem {
  name: string;
  path: string;
  kind: string;
  sizeBytes: number;
  mtime: number;
  contentText?: string;
  truncated?: boolean;
  storageId?: string;
}

export interface PreparedArtifactUpload {
  item: ArtifactUploadItem;
  // Full body text uploaded to file storage when larger than the inline
  // preview. Undefined when the whole file fit in contentText.
  body?: string;
}

export interface UploadFileLike {
  name: string;
  size: number;
  lastModified?: number;
  text(): Promise<string>;
  slice?(start?: number, end?: number): { text(): Promise<string> };
}

const textExtensions = new Set([
  ".inp",
  ".out",
  ".txt",
  ".xyz",
  ".log",
  ".bibtex",
  ".property",
  ".dat",
  ".allxyz",
  ".trj",
  ".cis",
  ".engrad",
  ".hess",
  ".opt",
  ".smd",
  ".uno",
  ".gradient",
  ".plot",
  ".uco",
  ".cube",
]);

export function classifyUploadedArtifact(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".inp")) return ARTIFACT_KIND.input;
  if (lower.endsWith(".stdout.out")) return ARTIFACT_KIND.stdout;
  if (lower.endsWith(".out")) return ARTIFACT_KIND.output;
  if (lower.endsWith(".cube")) return ARTIFACT_KIND.cube;
  if (/\.v\d+\.xyz$/i.test(name) || /\.h\d+\.v\d+\.xyz$/i.test(name)) return ARTIFACT_KIND.vibmode;
  if (lower.endsWith(".trj") || lower.endsWith(".allxyz")) return ARTIFACT_KIND.trj;
  if (lower.endsWith(".property") || lower.endsWith(".property.txt")) return ARTIFACT_KIND.property;
  if (isSupportedTextUpload(name)) return ARTIFACT_KIND.other;
  return "unsupported";
}

export function isSupportedTextUpload(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".property.txt")) return true;
  if (/\.v\d+\.xyz$/i.test(name) || /\.h\d+\.v\d+\.xyz$/i.test(name)) return true;
  for (const ext of textExtensions) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export async function prepareArtifactUpload(file: UploadFileLike): Promise<PreparedArtifactUpload> {
  if (!isSupportedTextUpload(file.name)) {
    throw new Error(`${file.name} is not a supported text artifact type.`);
  }
  if (file.size > UPLOAD_MAX_FILE_BYTES) {
    throw new Error(`${file.name} is larger than the ${formatBytes(UPLOAD_MAX_FILE_BYTES, { decimals: 0 })} upload limit.`);
  }

  const storedText = await readStoredText(file);
  const preview = storedText.slice(0, UPLOAD_INLINE_PREVIEW_CHARS);

  const item: ArtifactUploadItem = {
    name: basename(file.name),
    path: `uploaded://${file.name}`,
    kind: classifyUploadedArtifact(file.name),
    sizeBytes: file.size,
    mtime: file.lastModified ?? Date.now(),
  };
  if (preview.length > 0) item.contentText = preview;
  if (file.size > UPLOAD_MAX_TEXT_CHARS || storedText.length > UPLOAD_MAX_TEXT_CHARS) item.truncated = true;

  // Bodies larger than the inline preview go to file storage as one blob.
  const body = storedText.length > UPLOAD_INLINE_PREVIEW_CHARS ? storedText : undefined;

  return { item, body };
}

function readStoredText(file: UploadFileLike): Promise<string> {
  if (file.slice) {
    return file.slice(0, UPLOAD_MAX_TEXT_CHARS + 1).text().then((text) => text.slice(0, UPLOAD_MAX_TEXT_CHARS));
  }
  return file.text().then((text) => text.slice(0, UPLOAD_MAX_TEXT_CHARS));
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
