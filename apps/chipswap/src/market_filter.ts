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
  /**
   * The one axis that replaces the set rather than trimming it: on, the market
   * shows the chips you have ignored and nothing else. Every card in that view
   * carries the same action, which is what makes it a list to review rather
   * than a grid to search.
   */
  showIgnored: boolean;
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
    // Ignoring is a standing instruction, so the market honours it on opening
    // and the reader asks to see what it withheld.
    showIgnored: false,
    requirements: [],
    designer: null,
    search: "",
    sort: "recent",
  };
}

export function isDefaultFilter(filter: MarketFilter): boolean {
  return (
    !filter.hideOwned &&
    !filter.showNsfw &&
    !filter.showIgnored &&
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

/**
 * What an empty grid says about itself.
 *
 * An empty market has to say why it is empty, or a filtered one looks like a
 * broken one. The case this exists for is the reader who has ignored every chip
 * that matched: the chips are there, they put them out of sight themselves, and
 * being told to go and add designers would be plainly untrue.
 */
export function emptyMarketMessage(
  filter: MarketFilter,
  ignoredHidden: number,
): string {
  const otherwiseDefault = isDefaultFilter({ ...filter, showIgnored: false });
  if (filter.showIgnored) {
    return otherwiseDefault
      ? "You have not ignored any chips. Ignore one from a card in the market and it will be here."
      : "No chip you ignored matches these filters. Widen them to see the rest.";
  }
  if (ignoredHidden > 0) {
    return (
      "Every chip that matched is one you ignored. Tick \u201CShow ignored chips\u201D to see " +
      (ignoredHidden === 1 ? "it" : "them") +
      "."
    );
  }
  return otherwiseDefault
    ? "Nothing here yet. Add designers in the Directory, then refresh catalogs to see what they have published."
    : "No chip matches these filters. Widen them, or clear them to see the whole market.";
}

export function filterLabel(filter: MarketFilter): string {
  const parts: string[] = [];
  // First, because it is the only axis that says what set is on screen at all
  // rather than which of it survived. Everything after it narrows this one.
  if (filter.showIgnored) parts.push("Ignored chips");
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
