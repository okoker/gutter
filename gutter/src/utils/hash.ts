/**
 * Compute a fast, deterministic hash of content for change detection.
 * Not cryptographic — just for detecting whether content changed.
 */
export function hashContent(content: string): string {
  // Normalize line endings so \r\n and \n produce the same hash
  const normalized = content.replace(/\r\n/g, "\n");
  // djb2 hash — fast, good distribution for text
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) | 0;
  }
  // Convert to unsigned hex
  return (hash >>> 0).toString(16);
}
