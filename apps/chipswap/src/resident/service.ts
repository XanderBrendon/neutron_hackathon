// The background process. It owns the network and the cache; the tile owns the
// view. Nothing here decides what the market shows — only what has been
// fetched and how old it is.

import { exposeTool, publishAppStateChange } from "neutron-tools/app";
import { fetchCatalog } from "./agent.ts";
import { CATALOG_TTL_MS, staleDesigners } from "./freshness.ts";
import { evict, readAll, write, type CachedCatalog } from "./store.ts";

/** The batch cap the deleted backend fetch used. Keeping the number means a
 *  peer sees the same shape of traffic after this change as before it, and a
 *  forty-designer directory does not open forty sockets at once. */
export const MAX_REFRESH_CONCURRENCY = 8;

/** The app-state topic an open Market listens on. */
export const CATALOG_TOPIC = "catalogs";

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
