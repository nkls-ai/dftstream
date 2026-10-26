/** Trigger a browser download for a Blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revocation so the download has a chance to start before the URL is
  // invalidated (immediate revoke races the browser in Firefox).
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadText(filename: string, text: string) {
  downloadBlob(filename, new Blob([text], { type: "text/plain;charset=utf-8" }));
}
