import { useCallback, useRef, useState, type DragEvent } from "react";
import { useDataSource } from "../data/DataSource";
import { ARTIFACT_KIND } from "../data/types";
import { isSupportedTextUpload, UPLOAD_MAX_FILE_BYTES } from "../lib/artifactUpload";
import { userErrorMessage } from "../lib/errorReporting";

export function ArtifactUploadPanel({ runId }: { runId: string }) {
  const ds = useDataSource();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadFiles = useCallback(async (rawFiles: File[]) => {
    const accepted = rawFiles.filter((file) => isSupportedTextUpload(file.name) && file.size <= UPLOAD_MAX_FILE_BYTES);
    const rejected = rawFiles.length - accepted.length;
    if (accepted.length === 0) {
      setMessage(null);
      setError("No supported text artifacts selected. Use ORCA text outputs, XYZ trajectories, or .cube files up to 50 MB.");
      return;
    }

    setUploading(true);
    setError(null);
    setMessage(`Uploading ${accepted.length} file${accepted.length !== 1 ? "s" : ""}...`);
    try {
      const uploaded = await ds.uploadRunArtifacts(runId, accepted);
      const cubeCount = uploaded.filter((item) => item.kind === ARTIFACT_KIND.cube).length;
      const skipped = rejected > 0 ? ` Skipped ${rejected} unsupported or oversized file${rejected !== 1 ? "s" : ""}.` : "";
      const cubeHint = cubeCount > 0 ? " Cube files are now available in the Structure tab." : "";
      setMessage(`Attached ${uploaded.length} file${uploaded.length !== 1 ? "s" : ""} to this run.${cubeHint}${skipped}`);
    } catch (err) {
      setMessage(null);
      // Route through userErrorMessage like the delete handler so non-Error
      // throws are reported with context instead of a bare "Upload failed.".
      setError(userErrorMessage(err, "upload artifacts"));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, [ds, runId]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    void uploadFiles(files);
  }, [uploadFiles]);

  return (
    <div
      className={"artifact-upload" + (dragging ? " dragging" : "") + (uploading ? " uploading" : "")}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
      onDrop={handleDrop}
    >
      <div className="artifact-upload-mark">+</div>
      <div className="artifact-upload-copy">
        <strong>Attach files to this run</strong>
        <span>Drop ORCA outputs, XYZ trajectories, or cube files. Uploaded cubes become selectable in the Structure tab.</span>
      </div>
      <div className="artifact-upload-actions">
        <button
          type="button"
          className="dl-btn artifact-upload-btn"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? "Uploading..." : "Choose files"}
        </button>
        <input aria-label="Upload artifact files"
          ref={inputRef}
          type="file"
          multiple
          className="artifact-upload-input"
          accept=".inp,.out,.txt,.xyz,.log,.bibtex,.property,.dat,.allxyz,.trj,.cis,.engrad,.hess,.opt,.smd,.uno,.gradient,.plot,.uco,.cube"
          onChange={(event) => void uploadFiles(Array.from(event.currentTarget.files ?? []))}
        />
      </div>
      {(message || error) && (
        <div className={"artifact-upload-status" + (error ? " error" : "")}>{error ?? message}</div>
      )}
    </div>
  );
}
