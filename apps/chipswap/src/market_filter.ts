// The market filter axes.
//
// The backend used to apply these; it has no catalog to apply them to any
// more, so `src/market_page.ts` applies them over the browser's copy and this
// file is left owning the axes themselves: what they are, what they are called
// in the interface, and what a set of them reads as.

/**
 * The longest search the market reads. Filtering happens in the tile now, so
 * this is a UI bound rather than a backend one: a search longer than this says
 * nothing a shorter one does not, and the cap keeps one very long paste from
 * scanning every row against it.
 */
export const MAX_SEARCH_CHARS = 64;

export type RequirementFacet =
  /** Something I hold or publish already satisfies this design's requirements. */
  | "tradeable"
  | "open"
  | "approval"
  | "min_colors"
  | "max_coverage"
  | "tag_rule";

export type MarketSort = "recent" | "oldest" | "title" | "designer";

export type MarketFilter = {
  /** Chips already in your collection, shown unless you ask to hide them. */
  hideOwned: boolean;
  /** Tagged chips are left out until they are asked for. */
  showNsfw: boolean;
  /** Empty asks for no constraint; two facets widen each other. */
  requirements: RequirementFacet[];
  /** A designer principal, or null for every designer. */
  designer: string | null;
  search: string;
  sort: MarketSort;
};

// The order here is canonical: it is the order the checkboxes are drawn in, the
// order the facets travel in, and the order the label names them. A set of
// choices has no order of its own, so giving it one keeps two equal filters
// from looking different.
export const REQUIREMENT_FACETS = [
  { value: "tradeable", label: "Trades I can make" },
  { value: "open", label: "Swaps freely" },
  { value: "approval", label: "Designer approves" },
  { value: "min_colors", label: "Minimum colors" },
  { value: "max_coverage", label: "Coverage cap" },
  { value: "tag_rule", label: "Asks about the NSFW tag" },
] as const satisfies readonly { value: RequirementFacet; label: string }[];

export const SORT_OPTIONS = [
  { value: "recent", label: "Recently seen" },
  { value: "oldest", label: "Oldest seen" },
  { value: "title", label: "Title A–Z" },
  { value: "designer", label: "By designer" },
] as const satisfies readonly { value: MarketSort; label: string }[];

export function defaultFilter(): MarketFilter {
  return {
    // The market opens as the whole directory: hiding part of it before anyone
    // asked makes chips look missing rather than filtered. Owned rows carry an
    // "owned" tag, and the checkbox is there for whoever wants them gone.
    hideOwned: false,
    // Tagged chips stay out until they are asked for. The market says how many
    // it left out, so this is never a silent omission.
    showNsfw: false,
    requirements: [],
    designer: null,
    search: "",
    sort: "recent",
  };
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseFacets(value: unknown): RequirementFacet[] {
  if (!Array.isArray(value)) return [];
  const asked = new Set(
    value.filter((entry): entry is string => typeof entry === "string"),
  );
  // Reading through the canonical list does the whole job at once: a name this
  // build does not know is dropped, a repeat collapses, and the order is the
  // one the rest of the app uses however the stored copy was written.
  return REQUIREMENT_FACETS.map((facet) => facet.value).filter((facet) =>
    asked.has(facet),
  );
}

function parseSort(value: unknown, fallback: MarketSort): MarketSort {
  return SORT_OPTIONS.some((option) => option.value === value)
    ? (value as MarketSort)
    : fallback;
}

/**
 * A filter read back from somewhere that could hold anything — a stored copy,
 * an older build's copy, a hand-edited one.
 *
 * Every axis falls back on its own rather than the whole filter failing
 * together: a set of choices where one name has gone bad is still mostly the
 * choices the reader made, and throwing all of them away would be a worse
 * answer than keeping the ones that still read.
 */
export function parseFilter(value: unknown): MarketFilter {
  const fallback = defaultFilter();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fallback;
  }
  const stored = value as Record<string, unknown>;
  return {
    hideOwned: parseBoolean(stored.hideOwned, fallback.hideOwned),
    showNsfw: parseBoolean(stored.showNsfw, fallback.showNsfw),
    requirements: parseFacets(stored.requirements),
    // An empty principal is nobody, which is what "every designer" already
    // says, so it reads back as no constraint rather than as one nothing meets.
    designer:
      typeof stored.designer === "string" && stored.designer !== ""
        ? stored.designer
        : fallback.designer,
    search:
      typeof stored.search === "string"
        ? normalizedSearch(stored.search)
        : fallback.search,
    sort: parseSort(stored.sort, fallback.sort),
  };
}

export function isDefaultFilter(filter: MarketFilter): boolean {
  return (
    !filter.hideOwned &&
    !filter.showNsfw &&
    filter.requirements.length === 0 &&
    filter.designer === null &&
    filter.search === "" &&
    filter.sort === "recent"
  );
}

/** The facet added if it was absent, removed if it was there. */
export function toggleFacet(
  facets: readonly RequirementFacet[],
  facet: RequirementFacet,
): RequirementFacet[] {
  return facets.includes(facet)
    ? facets.filter((current) => current !== facet)
    : [...facets, facet];
}

function canonical(facets: readonly RequirementFacet[]): RequirementFacet[] {
  return REQUIREMENT_FACETS.map((entry) => entry.value).filter((value) =>
    facets.includes(value),
  );
}

/** The search as the filter actually applies it: trimmed, and cut to fit. */
export function normalizedSearch(search: string): string {
  return search.trim().slice(0, MAX_SEARCH_CHARS);
}

/**
 * The ticked facets in the canonical order, with repeats collapsed. A set of
 * choices has no order of its own, so giving it one keeps two equal filters
 * from reading as different ones.
 */
export function canonicalFacets(
  facets: readonly RequirementFacet[],
): RequirementFacet[] {
  return canonical(facets);
}

export function filterLabel(filter: MarketFilter): string {
  const parts: string[] = [];
  if (filter.hideOwned) parts.push("Chips I don't own");
  if (filter.requirements.length > 0) {
    // Joined with "or" because the facets widen each other: ticking two asks
    // for the designs matching either one.
    parts.push(
      canonical(filter.requirements)
        .map(
          (value) =>
            REQUIREMENT_FACETS.find((facet) => facet.value === value)?.label ??
            value,
        )
        .join(" or "),
    );
  }
  // The principal itself would say nothing a reader could use, and the name is
  // the select's business rather than the label's.
  if (filter.designer !== null) parts.push("one designer");
  const search = filter.search.trim();
  if (search !== "") parts.push(`“${search}”`);
  // Only the unusual choice is worth naming: hiding tagged chips is the default.
  if (filter.showNsfw) parts.push("NSFW shown");
  // Sorting is deliberately absent: it reorders the view rather than narrowing
  // it, so naming it here would claim something was left out that was not.
  if (parts.length === 0) return "Everything in your directory";
  return parts.join(" · ");
}
