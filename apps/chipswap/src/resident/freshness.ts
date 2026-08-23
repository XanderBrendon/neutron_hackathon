// Which designers are worth asking again.
//
// The TTL is per designer rather than one stamp over the whole cache: adding
// one designer should refetch one designer, and a newly added one should not
// have to wait out somebody else's window before it appears.

import type { CachedCatalog } from "./store.ts";

/** One day. A catalog older than this is refetched when the Market opens. */
export const CATALOG_TTL_MS = 86_400_000;

/**
 * The members of `designers` whose cached catalog is missing, older than
 * `ttlMs`, or carrying an error from the last attempt. Input order is kept and
 * repeats are collapsed, so a refresh visits each peer once and in the order
 * the caller listed the directory.
 */
export function staleDesigners(
  designers: string[],
  cached: CachedCatalog[],
  nowMs: number,
  ttlMs: number,
): string[] {
  const byDesigner = new Map(cached.map((entry) => [entry.designer, entry]));
  const seen = new Set<string>();
  const stale: string[] = [];
  for (const designer of designers) {
    if (seen.has(designer)) continue;
    seen.add(designer);
    const entry = byDesigner.get(designer);
    if (
      entry === undefined ||
      // An entry that only ever failed has nothing to go stale; ask again.
      entry.lastError !== null ||
      entry.fetchedAtMs === 0 ||
      // A stamp in the future is a clock fault, not freshness to distrust.
      nowMs - entry.fetchedAtMs >= ttlMs
    ) {
      stale.push(designer);
    }
  }
  return stale;
}
