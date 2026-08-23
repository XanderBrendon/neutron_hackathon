// The market page, assembled in the tile.
//
// The backend used to do this over a stored catalog cache. It does not store
// one any more, so the join happens here: cached catalogs from this machine,
// the directory and holdings from the canister, and the filter from the
// reader. `total` counts the filtered set rather than the cache, because a
// page control over a number that does not match what was filtered is a page
// control that lies about how much is left.

import type { Art, Chip, Design } from "./api.ts";
import { decodePixels } from "./chip.ts";
import {
  canonicalFacets,
  normalizedSearch,
  type MarketFilter,
  type MarketSort,
  type RequirementFacet,
} from "./market_filter.ts";
import type { CachedCatalog } from "./resident/store.ts";
import {
  check,
  measure,
  type Metrics,
  type TradeRequirements,
} from "./requirements.ts";

/** Only the directory fields the market actually reads. */
export type MarketDirectoryEntry = {
  canister: string;
  ignored: boolean;
  contactName: string | null;
};

export type MarketInput = {
  catalogs: CachedCatalog[];
  directory: MarketDirectoryEntry[];
  /** `designer/designId` for every design already in the collection. */
  ownedKeys: Set<string>;
  holdings: Chip[];
  ownDesigns: Design[];
};

export type MarketRow = {
  designer: string;
  designId: number;
  title: string;
  art: Art;
  requirements: TradeRequirements;
  nsfw: boolean;
  /** u64 as text, the way it left the peer. */
  designRevision: string;
  owned: boolean;
  fetchedAtMs: number;
  contactName: string | null;
};

export type MarketPage = {
  rows: MarketRow[];
  total: number;
  nsfwHidden: number;
};

export function ownedKey(designer: string, designId: number): string {
  return `${designer}/${designId}`;
}

/** What we could put up in a trade, measured once per page rather than per row. */
type Offer = { metrics: Metrics; nsfw: boolean };

function offersOf(input: MarketInput): Offer[] {
  return [
    ...input.holdings.map((chip) => ({
      metrics: measure(decodePixels(chip.art.pixels), chip.art.palette),
      nsfw: chip.nsfw,
    })),
    // A draft cannot be offered: an offer of our own mints from a published
    // design, so a draft must not make anything look tradeable.
    ...input.ownDesigns
      .filter((design) => design.state === "published")
      .map((design) => ({
        metrics: measure(decodePixels(design.art.pixels), design.art.palette),
        nsfw: design.nsfw,
      })),
  ];
}

/** Whether anything we could offer satisfies this design's requirements. */
function tradeable(row: MarketRow, offers: Offer[]): boolean {
  return offers.some(
    (offer) => check(row.requirements, offer.metrics, offer.nsfw) === null,
  );
}

function matchesFacet(
  facet: RequirementFacet,
  row: MarketRow,
  offers: Offer[],
): boolean {
  const { approval, minColors, maxCoverage, nsfw } = row.requirements;
  switch (facet) {
    case "tradeable":
      return tradeable(row, offers);
    case "open":
      return (
        !approval && minColors === null && maxCoverage === null && nsfw === "any"
      );
    case "approval":
      return approval;
    case "min_colors":
      return minColors !== null;
    case "max_coverage":
      return maxCoverage !== null;
    case "tag_rule":
      return nsfw !== "any";
  }
}

/** Ties break on designer then id, so two equal rows never swap on re-render. */
function tiebreak(left: MarketRow, right: MarketRow): number {
  const byDesigner = left.designer.localeCompare(right.designer);
  return byDesigner !== 0 ? byDesigner : left.designId - right.designId;
}

function sorted(rows: MarketRow[], sort: MarketSort): MarketRow[] {
  const ranked = [...rows];
  switch (sort) {
    case "recent":
      ranked.sort((a, b) => b.fetchedAtMs - a.fetchedAtMs || tiebreak(a, b));
      break;
    case "oldest":
      ranked.sort((a, b) => a.fetchedAtMs - b.fetchedAtMs || tiebreak(a, b));
      break;
    case "title":
      ranked.sort((a, b) => a.title.localeCompare(b.title) || tiebreak(a, b));
      break;
    case "designer":
      ranked.sort(tiebreak);
      break;
  }
  return ranked;
}

export function buildMarketPage(
  input: MarketInput,
  filter: MarketFilter,
  offset: number,
  limit: number,
): MarketPage {
  // Ignoring is the only thing that withholds a designer here. One who did not
  // answer the last fetch keeps the chips they last gave us — an empty market
  // is a worse answer than a stale one — and the Market names them above the
  // grid instead, where the owner can withhold them if that is what they want.
  const followed = new Map(
    input.directory
      .filter((entry) => !entry.ignored)
      .map((entry) => [entry.canister, entry]),
  );

  // A cached designer the owner has since dropped contributes nothing. The
  // background evicts on that gesture too; this is the belt to that braces.
  const all: MarketRow[] = [];
  for (const catalog of input.catalogs) {
    const entry = followed.get(catalog.designer);
    if (entry === undefined) continue;
    for (const design of catalog.designs) {
      all.push({
        designer: catalog.designer,
        designId: design.designId,
        title: design.title,
        art: design.art,
        requirements: design.requirements,
        nsfw: design.nsfw,
        designRevision: design.designRevision,
        owned: input.ownedKeys.has(ownedKey(catalog.designer, design.designId)),
        fetchedAtMs: catalog.fetchedAtMs,
        contactName: entry.contactName,
      });
    }
  }

  const offers = offersOf(input);
  const search = normalizedSearch(filter.search).toLowerCase();
  const facets = canonicalFacets(filter.requirements);

  const narrowed = all.filter((row) => {
    if (filter.designer !== null && row.designer !== filter.designer) return false;
    if (
      search !== "" &&
      !row.title.toLowerCase().includes(search) &&
      !row.designer.toLowerCase().includes(search) &&
      !(row.contactName ?? "").toLowerCase().includes(search)
    ) {
      return false;
    }
    // Facets widen each other: ticking two asks for the designs matching either.
    if (
      facets.length > 0 &&
      !facets.some((facet) => matchesFacet(facet, row, offers))
    ) {
      return false;
    }
    if (filter.hideOwned && row.owned) return false;
    return true;
  });

  // The tag axis is applied last so the tally counts only rows that survived
  // every other filter. Counting earlier would report chips the reader had
  // already excluded for some other reason.
  const nsfwHidden = filter.showNsfw
    ? 0
    : narrowed.filter((row) => row.nsfw).length;
  const visible = filter.showNsfw ? narrowed : narrowed.filter((row) => !row.nsfw);

  const ranked = sorted(visible, filter.sort);
  return {
    rows: ranked.slice(offset, offset + limit),
    total: ranked.length,
    nsfwHidden,
  };
}
