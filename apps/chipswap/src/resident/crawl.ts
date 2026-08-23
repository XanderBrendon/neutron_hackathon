// The walk out across peers' directories.
//
// This is the frontier that used to be `mem.crawl` in the canister, moved to
// the machine that now does the asking. Nothing here reaches the network or
// the backend: it is handed pages and told about failures, and it answers who
// to ask next. That separation is the reason the walk can be tested at all —
// half of it used to be Motoko and half a React loop, and neither half was
// checkable without the other.
//
// Two sets do the work. `frontier` is who is left to ask; `visited` is who has
// been asked and is finished. A designer leaves one for the other exactly once.
// `found` is the subset of what we discovered that the backend does not
// already have, and it is the only thing this crawl will ever write.

import type { PeerDirectoryPage } from "../wire.ts";

/** The directory ceiling in backend/Directory.mo. Kept in step by hand: the
 *  browser cannot read a Motoko constant, and a client that walked past what
 *  the canister can hold would spend the whole crawl finding designers it
 *  could never seat. */
export const MAX_DIRECTORY = 512;

/** Peers asked per round. The batch the deleted backend step used, kept so a
 *  peer sees the same shape of traffic after this change as before it. */
export const MAX_CRAWL_CONCURRENCY = 8;

/** One page's worth. Matches Wire.MAX_DIRECTORY_PAGE. */
export const CRAWL_PAGE = 128;

export type CrawlTarget = {
  designer: string;
  offset: number;
};

export type CrawlSnapshot = {
  /** Peers finished, whether they answered or not. */
  queried: number;
  /** Peers still to ask. */
  remaining: number;
  /** New designers discovered, which is what the commit will carry. */
  found: number;
  /** Peers that refused a browser query because they have not upgraded. */
  outdated: number;
  /** Whether the directory has no room left for another designer. */
  full: boolean;
};

export type CrawlState = {
  readonly self: string;
  /** Every designer already in the backend's directory, eligible or not. */
  readonly known: Set<string>;
  readonly visited: Set<string>;
  readonly cursors: Map<string, number>;
  readonly frontier: Set<string>;
  readonly found: Set<string>;
  queried: number;
  outdated: number;
};

export type CrawlSeed = {
  self: string;
  /** Directory entries a crawl may ask: neither ignored nor retired. */
  eligible: string[];
  /** Every directory entry, so an ignored designer is not rediscovered. */
  known: string[];
};

export function createCrawl(seed: CrawlSeed): CrawlState {
  const known = new Set(seed.known);
  const frontier = new Set<string>();
  for (const designer of seed.eligible) {
    if (designer !== seed.self) frontier.add(designer);
  }
  return {
    self: seed.self,
    known,
    visited: new Set<string>(),
    cursors: new Map<string, number>(),
    frontier,
    found: new Set<string>(),
    queried: 0,
    outdated: 0,
  };
}

/**
 * The peers a round should call: those already part-read first, so a long
 * directory is finished rather than left half-collected behind newer work,
 * then frontier entries this crawl has not touched.
 *
 * Sorted rather than left in insertion order, so the same state always yields
 * the same batch. A crawl that cannot be replayed cannot be debugged from a
 * bug report.
 */
export function nextTargets(state: CrawlState, limit: number): CrawlTarget[] {
  if (limit <= 0) return [];
  const picked: CrawlTarget[] = [];

  const partRead = [...state.cursors.keys()].sort();
  for (const designer of partRead) {
    if (picked.length >= limit) return picked;
    // A cursor can outlive its place in the walk if the peer was finished
    // while part-read. The frontier decides, not the cursor.
    if (state.frontier.has(designer)) {
      picked.push({ designer, offset: state.cursors.get(designer) ?? 0 });
    }
  }

  const untouched = [...state.frontier].filter(
    (designer) => !state.cursors.has(designer),
  );
  untouched.sort();
  for (const designer of untouched) {
    if (picked.length >= limit) return picked;
    picked.push({ designer, offset: 0 });
  }
  return picked;
}

/** Room left in the backend's directory for designers it does not yet have. */
function room(state: CrawlState): number {
  const taken = state.known.size + state.found.size;
  return taken >= MAX_DIRECTORY ? 0 : MAX_DIRECTORY - taken;
}

/**
 * A peer answered with one page. Returns how many designers it introduced.
 *
 * `total` is a number the peer chose, so paging on it is bounded twice over:
 * the offset only advances while they are actually sending entries, and it
 * stops at the largest directory anyone could honestly have.
 */
export function notePage(
  state: CrawlState,
  designer: string,
  offset: number,
  page: PeerDirectoryPage,
): number {
  if (state.visited.has(designer)) return 0;
  // Refuse a page that does not answer the question we asked. A reply that
  // arrives late describes a position in a walk we are no longer at, and
  // acting on it would advance a cursor past entries nobody read.
  const expected = state.cursors.get(designer) ?? 0;
  if (expected !== offset) return 0;

  let added = 0;
  for (const candidate of page.entries) {
    if (candidate === state.self) continue;
    if (state.known.has(candidate) || state.found.has(candidate)) continue;
    // A designer we have no room to seat is not one to walk onward from
    // either: the crawl would spend the rest of its life finding people the
    // canister will refuse.
    if (room(state) === 0) break;
    state.found.add(candidate);
    state.frontier.add(candidate);
    added += 1;
  }

  const next = offset + page.entries.length;
  // Four ways a peer is done with us, and only the last is a backstop.
  //
  // A page shorter than the one we asked for is the honest end of a
  // directory: `served` hands back min(limit, total - offset), so anything
  // short means there was nothing more to send. Checking it as well as the
  // total is what stops a peer who lies about their size from being asked
  // five hundred times — the canister's version had only the total and the
  // ceiling, and a peer claiming four billion entries while dribbling one at
  // a time got every one of those rounds.
  const short = page.entries.length < CRAWL_PAGE;
  if (short || next >= page.total || next >= MAX_DIRECTORY) {
    finishPeer(state, designer);
  } else {
    state.cursors.set(designer, next);
  }
  return added;
}

/**
 * A peer we will not ask again this crawl, because they answered everything
 * they had or because they did not answer at all.
 */
export function finishPeer(state: CrawlState, designer: string): void {
  state.cursors.delete(designer);
  if (state.visited.has(designer)) return;
  state.visited.add(designer);
  state.frontier.delete(designer);
  state.queried += 1;
}

/**
 * A peer did not give us a page. Nobody is struck for it.
 *
 * The route is a query, and a peer on an older release exposes no browser-
 * callable dispatcher at all — concluding they had uninstalled Chipswap
 * because they have yet to upgrade would be a lie about the one thing that
 * conclusion claims to know. `unauthorized` is counted separately so the tile
 * can say why a crawl came back thin.
 */
export function noteFailure(
  state: CrawlState,
  designer: string,
  code: string,
): void {
  if (code === "unauthorized" && !state.visited.has(designer)) {
    state.outdated += 1;
  }
  finishPeer(state, designer);
}

export function snapshot(state: CrawlState): CrawlSnapshot {
  return {
    queried: state.queried,
    remaining: state.frontier.size,
    found: state.found.size,
    outdated: state.outdated,
    full: room(state) === 0,
  };
}
