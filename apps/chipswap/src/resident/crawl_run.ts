// Driving the walk: rounds of peer queries, then one commit.
//
// The walk itself is crawl.ts and knows nothing about networks. This module is
// the part that does know, and it is kept separate from service.ts for the
// same reason: its dependencies arrive as functions, so the promise it makes —
// that whatever was found reaches the backend — is checkable without a gateway
// or a canister.
//
// That promise is the whole of this file's job. There are three ways out of
// the loop: it runs out of peers, the owner stops it, or something throws. All
// three commit. A crawl reads nothing destructive and is cheap to repeat, so
// the only genuinely bad outcome is finding designers and dropping them on the
// floor.

import {
  CRAWL_PAGE,
  MAX_CRAWL_CONCURRENCY,
  createCrawl,
  nextTargets,
  noteFailure,
  notePage,
  snapshot,
  type CrawlState,
} from "./crawl.ts";
import type { DirectoryFetch } from "./agent.ts";

/**
 * The batch `chipswap_directory_note_found` accepts, matching MAX_FOUND_BATCH
 * in backend/main.mo — which is in turn `Directory.MAX_DIRECTORY`, because a
 * batch is bounded by the table it writes into.
 *
 * The walk stops adopting designers at that same ceiling, so in practice one
 * crawl is always one call and the loop below never takes its second turn. The
 * loop stays anyway: it is three lines, and if the two constants ever drift
 * apart it is the difference between a crawl that commits and one that loses
 * everything to `too_many`.
 */
export const MAX_FOUND_BATCH = 512;

export type CommitSummary = {
  added: number;
  skipped: number;
  full: boolean;
};

export type CrawlDeps = {
  /** The directory as the backend has it, and this canister's own address. */
  loadDirectory: () => Promise<{
    self: string;
    eligible: string[];
    known: string[];
  }>;
  fetchPage: (
    designer: string,
    offset: number,
    limit: number,
  ) => Promise<DirectoryFetch>;
  /** Seats one batch of found designers. Returns what the backend did. */
  commit: (canisters: string[]) => Promise<CommitSummary>;
  /** Called after each round, so an open tile can be nudged to re-read. */
  onRound?: () => void;
};

export type CrawlProgress = {
  active: boolean;
  queried: number;
  remaining: number;
  /** Designers this crawl discovered that the backend did not already have. */
  found: number;
  /** Peers that refused a browser query because they have not upgraded. */
  outdated: number;
  /** Whether the finds reached the backend. */
  committed: boolean;
  /** What the backend actually seated, which is not always what we found. */
  added: number;
  skipped: number;
  full: boolean;
  error: string | null;
};

export type CrawlHandle = {
  progress: () => CrawlProgress;
  stop: () => void;
  finished: Promise<CrawlProgress>;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startCrawl(deps: CrawlDeps): CrawlHandle {
  let state: CrawlState | null = null;
  let active = true;
  let stopping = false;
  let committed = false;
  let added = 0;
  let skipped = 0;
  let full = false;
  let error: string | null = null;

  function progress(): CrawlProgress {
    const walk = state === null
      ? { queried: 0, remaining: 0, found: 0, outdated: 0, full: false }
      : snapshot(state);
    return {
      active,
      queried: walk.queried,
      remaining: walk.remaining,
      found: walk.found,
      outdated: walk.outdated,
      committed,
      added,
      skipped,
      // Either the walk ran out of room or the backend says it has none.
      full: full || walk.full,
      error,
    };
  }

  async function commitFinds(): Promise<void> {
    if (state === null) return;
    const found = [...state.found];
    if (found.length === 0) {
      // An empty batch is an update call that changes nothing and costs
      // cycles. Saying "committed" for it is still true: there was nothing
      // left uncommitted.
      committed = true;
      return;
    }
    try {
      for (let at = 0; at < found.length; at += MAX_FOUND_BATCH) {
        const summary = await deps.commit(found.slice(at, at + MAX_FOUND_BATCH));
        added += summary.added;
        skipped += summary.skipped;
        full = full || summary.full;
      }
      committed = true;
    } catch (failure) {
      // The finds stay in `state.found`, so the owner is told what was
      // discovered rather than being shown an empty crawl, and a second
      // attempt has something to send.
      committed = false;
      error = error ?? message(failure);
    }
  }

  async function run(): Promise<CrawlProgress> {
    try {
      const directory = await deps.loadDirectory();
      state = createCrawl(directory);

      while (!stopping) {
        const targets = nextTargets(state, MAX_CRAWL_CONCURRENCY);
        if (targets.length === 0) break;

        // One round is one batch of concurrent queries, which is what bounds
        // the sockets a forty-designer directory opens.
        const replies = await Promise.all(
          targets.map(async (target) => ({
            target,
            reply: await deps.fetchPage(target.designer, target.offset, CRAWL_PAGE),
          })),
        );

        for (const { target, reply } of replies) {
          if ("page" in reply) {
            notePage(state, target.designer, target.offset, reply.page);
          } else {
            noteFailure(state, target.designer, reply.error);
          }
        }
        deps.onRound?.();
      }

      // A crawl the owner stopped has peers still in the frontier. They are
      // left there rather than marked finished: nothing was concluded about
      // them, and the counts should not pretend otherwise.
    } catch (failure) {
      error = message(failure);
    } finally {
      await commitFinds();
      active = false;
    }
    return progress();
  }

  const finished = run();

  return {
    progress,
    stop: () => {
      stopping = true;
    },
    finished,
  };
}
