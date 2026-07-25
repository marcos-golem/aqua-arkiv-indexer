/**
 * Chunk math for `backfill`. Split into its own file because off-by-one errors here are easy to
 * make and worth pinning down with a focused test, separate from anything network-shaped.
 */

/**
 * Split `[from, to]` into consecutive `[start, end]` spans of at most `size` blocks each.
 * Every block in the input range appears in exactly one chunk — no gaps, no overlap.
 */
export function chunkRanges(
  from: bigint,
  to: bigint,
  size: bigint,
): Array<readonly [bigint, bigint]> {
  if (size <= 0n) {
    throw new Error(`logChunkSize must be positive, got ${size}`);
  }
  if (from > to) {
    return [];
  }
  const chunks: Array<readonly [bigint, bigint]> = [];
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n < to ? start + size - 1n : to;
    chunks.push([start, end]);
  }
  return chunks;
}
