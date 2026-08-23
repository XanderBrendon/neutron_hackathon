// The background process. It owns the network; the tile owns the view.
//
// Two jobs live here and they are deliberately unalike. Catalogs are cached,
// because a peer's designs are worth having again tomorrow. A crawl is not
// cached at all: it is a variable in this module, it dies with the process, and
// the only thing about it that outlives the walk is the list of designers it
// found — which goes to the backend, once, at the end.

import { exposeTool, publishAppStateChange } from "neutron-tools/app";
import { loadDirectory as loadDirectoryPage, loadStatus, noteFoundDesigners } from "../api.ts";
import { fetchCatalog, fetchDirectoryPage } from "./agent.ts";
import { CATALOG_TTL_MS, staleDesigners } from "./freshness.ts";
import { startCrawl, type CrawlHandle, type CrawlProgress } from "./crawl_run.ts";
import { evict, readAll, write, type CachedCatalog } from "./store.ts";

/** The batch cap the deleted backend fetch used. Keeping the number means a
 *  peer sees the same shape of traffic after this change as before it, and a
 *  forty-designer directory does not open forty sockets at once. */
export const MAX_REFRESH_CONCURRENCY = 8;

/** The app-state topic an open Market listens on. */
export const CATALOG_TOPIC = "catalogs";

/** The app-state topic an open Directory listens on while a crawl runs. */
export const CRAWL_TOPIC = "crawl";

function principals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

async function refresh(
  designers: string[],
  force: boolean,
): Promise<{ fetched: string[]; failed: string[] }> {
  const existing = await readAll();
  const targets = force
    ? [...new Set(designers)]
    : staleDesigners(designers, existing, Date.now(), CATALOG_TTL_MS);

  const previous = new Map(existing.map((entry) => [entry.designer, entry]));
  const fetched: string[] = [];
  const failed: string[] = [];
  const queue = [...targets];

  async function worker(): Promise<void> {
    for (;;) {
      const designer = queue.shift();
      if (designer === undefined) return;
      const result = await fetchCatalog(designer);
      if ("designs" in result) {
        await write({
          designer,
          designs: result.designs,
          fetchedAtMs: Date.now(),
          lastError: null,
        });
        fetched.push(designer);
      } else {
        // A peer that did not answer keeps whatever it last gave us: a stale
        // catalog is more use than an empty one, and the error says which it
        // is. What it must not keep is a fresh timestamp, or the next open
        // would treat silence as a successful read.
        const before = previous.get(designer);
        await write({
          designer,
          designs: before?.designs ?? [],
          fetchedAtMs: before?.fetchedAtMs ?? 0,
          lastError: result.error,
        });
        failed.push(designer);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_REFRESH_CONCURRENCY, queue.length) }, worker),
  );

  // One notification for the batch, so an open Market re-reads once rather
  // than once per peer. The revision is the moment the batch finished: the
  // cache has no counter of its own, and every open tile only needs to know
  // that what it read is now older than what is stored.
  if (fetched.length > 0 || failed.length > 0) {
    await publishAppStateChange(CATALOG_TOPIC, Date.now()).catch(() => {
      // A tile that missed the nudge still reloads when it is next opened.
    });
  }
  return { fetched, failed };
}

exposeTool(
  "chipswap_market_catalogs",
  {
    title: "Cached catalogs",
    description: "Every peer catalog this machine has fetched.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
  },
  async () => ({ catalogs: (await readAll()) as CachedCatalog[] }),
);

exposeTool(
  "chipswap_market_refresh",
  {
    title: "Refresh catalogs",
    description: "Query peers for their published designs.",
    inputSchema: {
      type: "object",
      required: ["designers"],
      properties: {
        designers: { type: "array", items: { type: "string" } },
        force: { type: "boolean" },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
  },
  async ({ designers, force }) => refresh(principals(designers), force === true),
);

exposeTool(
  "chipswap_market_evict",
  {
    title: "Forget catalogs",
    description: "Drop cached catalogs for designers no longer followed.",
    inputSchema: {
      type: "object",
      required: ["designers"],
      properties: { designers: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
  },
  async ({ designers }) => ({ removed: await evict(principals(designers)) }),
);

// --- The crawl ---------------------------------------------------------------
//
// One crawl at a time, held in a variable that dies with this process. There is
// no store call anywhere below: an interrupted walk is not worth resuming, and
// the designers it found were handed to the backend before it ended.

let running: CrawlHandle | null = null;
let last: CrawlProgress | null = null;

/**
 * The whole directory, in the two shapes a crawl needs it.
 *
 * `known` is every entry and `eligible` is the ones a crawl may approach. The
 * difference is what stops a crawl undoing an ignore: an ignored designer is
 * withheld from the walk by `eligible`, and withheld from the finds by `known`,
 * so they are neither asked nor rediscovered.
 *
 * These go through src/api.ts rather than a second set of self-calls written
 * here. The parsers and the ok/err handling are the same ones the tile uses,
 * which is the point — a background with its own idea of what a directory
 * entry looks like is a background that can disagree with the tile about who
 * is ignored.
 */
async function loadDirectory(): Promise<{
  self: string;
  eligible: string[];
  known: string[];
}> {
  const self = (await loadStatus()).canister;

  const known: string[] = [];
  const eligible: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await loadDirectoryPage(offset, DIRECTORY_PAGE);
    for (const entry of page.entries) {
      known.push(entry.canister);
      if (!entry.ignored) eligible.push(entry.canister);
    }
    offset += page.entries.length;
    if (page.entries.length === 0 || offset >= page.total) break;
  }
  return { self, eligible, known };
}

/** How much of our own directory to read per query. */
const DIRECTORY_PAGE = 100;

const idle: CrawlProgress = {
  active: false,
  queried: 0,
  remaining: 0,
  found: 0,
  outdated: 0,
  committed: false,
  added: 0,
  skipped: 0,
  full: false,
  error: null,
};

function currentProgress(): CrawlProgress {
  if (running !== null) return running.progress();
  return last ?? idle;
}

/** The snapshot as the tile receives it: one flat record of JSON values. */
function report(progress: CrawlProgress) {
  return {
    active: progress.active,
    queried: progress.queried,
    remaining: progress.remaining,
    found: progress.found,
    outdated: progress.outdated,
    committed: progress.committed,
    added: progress.added,
    skipped: progress.skipped,
    full: progress.full,
    error: progress.error,
  };
}

async function notifyCrawl(): Promise<void> {
  await publishAppStateChange(CRAWL_TOPIC, Date.now()).catch(() => {
    // A tile that missed the nudge still reads progress when it next asks.
  });
}

function begin(): CrawlProgress {
  // A second crawl would ask every peer twice and race the first one's commit.
  // Handing back the running one's progress is more useful than an error: the
  // caller wanted a crawl, and there is one.
  if (running !== null && running.progress().active) return running.progress();

  const handle = startCrawl({
    loadDirectory,
    fetchPage: fetchDirectoryPage,
    commit: noteFoundDesigners,
    onRound: () => void notifyCrawl(),
  });
  running = handle;

  void handle.finished.then(async (outcome) => {
    last = outcome;
    if (running === handle) running = null;
    // The directory changed, so the tile has both a crawl to redraw and a
    // table to reload.
    await notifyCrawl();
  });

  return handle.progress();
}

exposeTool(
  "chipswap_crawl_start",
  {
    title: "Find more designers",
    description: "Walk out across peers' directories for designers we do not know.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
  },
  async () => report(begin()),
);

exposeTool(
  "chipswap_crawl_stop",
  {
    title: "Stop looking",
    description: "End the running crawl and save whatever it has found.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
  },
  async () => {
    const handle = running;
    if (handle === null) return report(currentProgress());
    handle.stop();
    // Waiting for the commit is the point of stopping: the caller is told what
    // was saved, not what was in flight when they asked.
    return report(await handle.finished);
  },
);

exposeTool(
  "chipswap_crawl_progress",
  {
    title: "Crawl progress",
    description: "How far the running crawl has got, or how the last one ended.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
  },
  async () => report(currentProgress()),
);
