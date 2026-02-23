/**
 * Chunk a string into pieces of max `size` characters.
 * Used by bot interfaces to split long messages for platform limits.
 */
export function chunkResponse(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}
