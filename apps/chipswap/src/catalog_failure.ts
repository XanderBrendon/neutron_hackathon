// The designers the Market could not read, and what to tell the owner about it.
//
// A catalog read is a query, so nothing here is evidence the canister draws a
// conclusion from — this app no longer draws any. It is evidence put in front
// of the owner, next to the two things they might want to do about it.
//
// The facts come from the browser's own cache rather than from the result of
// the fetch that just ran. The background writes `lastError` on every attempt
// that came back with nothing and clears it on every attempt that did not, so
// this is one list whether the fetch was the automatic one on opening the
// Market or the owner pressing Refresh, and a designer leaves it the moment
// they answer.

import type { CachedCatalog } from "./resident/store.ts";

/** Only the directory fields a failure notice reads. */
export type FailureDirectoryEntry = {
  canister: string;
  ignored: boolean;
  contactName: string | null;
};

export type FailedDesigner = {
  canister: string;
  contactName: string | null;
  /** Reads as a predicate after the designer's name. */
  reason: string;
  /**
   * Wall-clock ms of the last catalog this machine did read from them, or 0.
   * The difference decides what removing them actually costs: a designer whose
   * chips are on screen from yesterday is not a designer who has never
   * answered at all.
   */
  lastFetchedAtMs: number;
};

/**
 * What one failed attempt says about the peer, in the owner's terms.
 *
 * The codes are the kernel's ingress error variant plus the few the background
 * makes up for a reply it could not unwrap. Anything else is an exception
 * message, which is about this machine's connection as often as about theirs —
 * so it falls back to the one claim that is always true.
 */
export function failureReason(code: string): string {
  switch (code) {
    // Not a failure so much as a version gap. `catalog` only became readable
    // by a browser in release 116; before it, the route admits canisters only
    // and refuses everyone else outright.
    case "unauthorized":
      return "is on an older release, so their catalog cannot be read from a browser yet";
    case "not_found":
      return "answered nothing on the catalog route, so they may have uninstalled Chipswap";
    case "revoked":
    case "revoked_after_dispatch":
      return "has withdrawn the route this reads";
    case "busy":
    case "rate_limited":
      return "was too busy to answer";
    case "low_cycles":
      return "is out of cycles";
    case "bad_request":
    case "too_large":
      return "refused the request";
    case "handler_failed":
      return "answered with an error";
    case "undecodable":
    case "malformed_reply":
    case "malformed_envelope":
      return "answered with something this version of Chipswap cannot read";
    default:
      return "did not answer";
  }
}

/**
 * Every designer the owner still follows whose cached catalog carries an error.
 *
 * Ignored designers are left out because they are not being asked: their
 * catalog was evicted when they were ignored, and naming them would be asking
 * the owner to decide something they already decided. A cached catalog whose
 * designer has left the directory is left out for the same reason the market
 * page drops it — the cache is evicted on that gesture, and this is the belt to
 * that braces.
 */
export function failedDesigners(
  catalogs: CachedCatalog[],
  directory: FailureDirectoryEntry[],
): FailedDesigner[] {
  const byDesigner = new Map(catalogs.map((entry) => [entry.designer, entry]));
  const failed: FailedDesigner[] = [];
  // Ordered by the directory rather than the cache: the owner reads these
  // names in the Directory's order everywhere else, and IndexedDB's is its own.
  for (const entry of directory) {
    if (entry.ignored) continue;
    const cached = byDesigner.get(entry.canister);
    if (cached === undefined || cached.lastError === null) continue;
    failed.push({
      canister: entry.canister,
      contactName: entry.contactName,
      reason: failureReason(cached.lastError),
      lastFetchedAtMs: cached.fetchedAtMs,
    });
  }
  return failed;
}
