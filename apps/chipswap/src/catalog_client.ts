// The tile's side of the background's three tools.
//
// A same-app tool call needs no owner dialog, so the Market reaches the cache
// as freely as it reaches the backend. Everything crossing this boundary is
// parsed rather than trusted: the background is our own code, but it is still
// another process, and a shape that changed underneath us should fail here
// rather than halfway through a render.

import { callTool, loadTileContext } from "neutron-tools/app";
import type { PeerDesign } from "./wire.ts";
import type { CachedCatalog } from "./resident/store.ts";

function backgroundTarget(): `app:${string}:background` {
  const app = loadTileContext().app;
  if (app === null) throw new Error("The tile has no app context");
  return `app:${app}:background`;
}

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await callTool({
    target: backgroundTarget(),
    name,
    arguments: args as never,
  });
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`The catalog service returned no ${name} result`);
  }
  return result as Record<string, unknown>;
}

function isDesign(value: unknown): value is PeerDesign {
  if (typeof value !== "object" || value === null) return false;
  const design = value as Record<string, unknown>;
  return (
    typeof design.designId === "number" &&
    typeof design.title === "string" &&
    typeof design.designRevision === "string" &&
    typeof design.nsfw === "boolean" &&
    typeof design.art === "object" &&
    design.art !== null &&
    typeof design.requirements === "object" &&
    design.requirements !== null
  );
}

function parseCatalog(value: unknown): CachedCatalog {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid cached catalog");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.designer !== "string") throw new Error("Invalid designer");
  if (!Array.isArray(entry.designs)) throw new Error("Invalid catalog designs");
  return {
    designer: entry.designer,
    // A design we cannot read is dropped rather than rendered half-formed.
    designs: entry.designs.filter(isDesign),
    fetchedAtMs: typeof entry.fetchedAtMs === "number" ? entry.fetchedAtMs : 0,
    lastError: typeof entry.lastError === "string" ? entry.lastError : null,
  };
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export async function loadCachedCatalogs(): Promise<CachedCatalog[]> {
  const result = await call("chipswap_market_catalogs", {});
  if (!Array.isArray(result.catalogs)) throw new Error("Invalid catalog list");
  return result.catalogs.map(parseCatalog);
}

export async function refreshCatalogs(
  designers: string[],
  force: boolean,
): Promise<{ fetched: string[]; failed: string[] }> {
  const result = await call("chipswap_market_refresh", { designers, force });
  return { fetched: textList(result.fetched), failed: textList(result.failed) };
}

export async function evictCatalogs(designers: string[]): Promise<number> {
  if (designers.length === 0) return 0;
  const result = await call("chipswap_market_evict", { designers });
  return typeof result.removed === "number" ? result.removed : 0;
}
