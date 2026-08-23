// The tile's side of the background's three crawl tools.
//
// Same shape as src/catalog_client.ts, and same rule: a same-app tool call
// needs no owner dialog, and everything crossing the boundary is parsed rather
// than trusted. The background is our own code, but it is still another
// process, and a shape that changed underneath us should fail here rather than
// halfway through a render.

import { callTool, loadTileContext } from "neutron-tools/app";

/** What the tile knows about a crawl. Mirrors CrawlProgress in the background. */
export type CrawlProgress = {
  active: boolean;
  /** Peers finished, whether they answered or not. */
  queried: number;
  /** Peers still to ask. */
  remaining: number;
  /** Designers found that the backend did not already have. */
  found: number;
  /** Peers on a release that will not answer a browser. */
  outdated: number;
  /** Whether the finds reached the backend. */
  committed: boolean;
  /** What the directory actually gained, which is not always what was found. */
  added: number;
  skipped: number;
  full: boolean;
  error: string | null;
};

function backgroundTarget(): `app:${string}:background` {
  const app = loadTileContext().app;
  if (app === null) throw new Error("The tile has no app context");
  return `app:${app}:background`;
}

async function call(name: string): Promise<Record<string, unknown>> {
  const result = await callTool({
    target: backgroundTarget(),
    name,
    arguments: {} as never,
  });
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`The crawl service returned no ${name} result`);
  }
  return result as Record<string, unknown>;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseProgress(value: Record<string, unknown>): CrawlProgress {
  return {
    active: value.active === true,
    queried: count(value.queried),
    remaining: count(value.remaining),
    found: count(value.found),
    outdated: count(value.outdated),
    committed: value.committed === true,
    added: count(value.added),
    skipped: count(value.skipped),
    full: value.full === true,
    error: typeof value.error === "string" ? value.error : null,
  };
}

export async function startCrawl(): Promise<CrawlProgress> {
  return parseProgress(await call("chipswap_crawl_start"));
}

/** Resolves once the crawl has stopped and its finds have been committed. */
export async function stopCrawl(): Promise<CrawlProgress> {
  return parseProgress(await call("chipswap_crawl_stop"));
}

export async function crawlProgress(): Promise<CrawlProgress> {
  return parseProgress(await call("chipswap_crawl_progress"));
}
