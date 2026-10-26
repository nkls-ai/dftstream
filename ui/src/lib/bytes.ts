/** Human-readable byte size: "512 B", "3.2 KB", "128 MB". */
export function formatBytes(n: number, { decimals = 1 }: { decimals?: number } = {}): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(decimals)} KB`;
  return `${(kb / 1024).toFixed(decimals)} MB`;
}
