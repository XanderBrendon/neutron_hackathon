import { expect, test } from "bun:test";
import {
  REQUIREMENT_FACETS,
  SORT_OPTIONS,
  MAX_SEARCH_CHARS,
  defaultFilter,
  emptyMarketMessage,
  filterLabel,
  canonicalFacets,
  isDefaultFilter,
  normalizedSearch,
  toggleFacet,
} from "../src/market_filter.ts";

test("the market opens showing owned chips, with tagged chips out of the way", () => {
  const filter = defaultFilter();
  expect(filter).toEqual({
    hideOwned: false,
    showNsfw: false,
    showIgnored: false,
    requirements: [],
    designer: null,
    search: "",
    sort: "recent",
  });
  expect(isDefaultFilter(filter)).toBe(true);
});

test("any axis moved off its default is no longer the default", () => {
  const filter = defaultFilter();
  expect(isDefaultFilter({ ...filter, hideOwned: true })).toBe(false);
  expect(isDefaultFilter({ ...filter, showNsfw: true })).toBe(false);
  expect(isDefaultFilter({ ...filter, showIgnored: true })).toBe(false);
  expect(isDefaultFilter({ ...filter, requirements: ["open"] })).toBe(false);
  expect(isDefaultFilter({ ...filter, designer: "aaaaa-aa" })).toBe(false);
  expect(isDefaultFilter({ ...filter, search: "moon" })).toBe(false);
  expect(isDefaultFilter({ ...filter, sort: "title" })).toBe(false);
});

test("the requirement facets offer exactly the documented choices", () => {
  expect(REQUIREMENT_FACETS.map((facet) => facet.value)).toEqual([
    "tradeable",
    "open",
    "approval",
    "min_colors",
    "max_coverage",
    "tag_rule",
  ]);
  expect(SORT_OPTIONS.map((option) => option.value)).toEqual([
    "recent",
    "oldest",
    "title",
    "designer",
  ]);
});

test("toggling a facet adds it, and toggling it again takes it away", () => {
  expect(toggleFacet([], "open")).toEqual(["open"]);
  expect(toggleFacet(["open"], "approval")).toEqual(["open", "approval"]);
  expect(toggleFacet(["open", "approval"], "open")).toEqual(["approval"]);
});

// The facets are a set, so the order a reader ticked them in must not change
// which designs match or make two equal filters look different.
test("facets canonicalize to a fixed order however they were ticked", () => {
  expect(canonicalFacets(["approval", "open"])).toEqual(["open", "approval"]);
  expect(canonicalFacets(["min_colors", "tradeable"])).toEqual([
    "tradeable",
    "min_colors",
  ]);
});

test("a repeated facet is the same set as naming it once", () => {
  expect(canonicalFacets(["open", "open"])).toEqual(["open"]);
});

test("no facet ticked canonicalizes to no constraint", () => {
  expect(canonicalFacets([])).toEqual([]);
});

test("a search of nothing but spaces narrows nothing", () => {
  expect(normalizedSearch("   ")).toBe("");
});

test("a search keeps its inner spacing and loses only its edges", () => {
  expect(normalizedSearch("  Moon  ")).toBe("Moon");
  expect(normalizedSearch("  blue moon  ")).toBe("blue moon");
});

test("the label names only the axes that are narrowing the view", () => {
  expect(filterLabel(defaultFilter())).toBe("Everything in your directory");
  // Sorting reorders rather than narrows, so it leaves the label alone.
  expect(filterLabel({ ...defaultFilter(), sort: "title" })).toBe(
    "Everything in your directory",
  );
  expect(filterLabel({ ...defaultFilter(), hideOwned: true })).toBe(
    "Chips I don't own",
  );
  // Named in the facet order, not the order they were ticked, so one set of
  // choices always reads as one sentence.
  expect(
    filterLabel({ ...defaultFilter(), requirements: ["open", "tradeable"] }),
  ).toBe("Trades I can make or Swaps freely");
  expect(filterLabel({ ...defaultFilter(), search: "moon" })).toBe(
    "\u201Cmoon\u201D",
  );
  expect(filterLabel({ ...defaultFilter(), designer: "aaaaa-aa" })).toBe(
    "one designer",
  );
  // Showing tagged chips widens the view rather than narrowing it, so it is
  // the one setting worth naming when it is not the default.
  expect(filterLabel({ ...defaultFilter(), showNsfw: true })).toBe("NSFW shown");
  // Ignoring is the one axis that replaces the set rather than trimming it, so
  // it is named first: it says what you are looking at at all.
  expect(filterLabel({ ...defaultFilter(), showIgnored: true })).toBe(
    "Ignored chips",
  );
  // Every axis at once still reads in the canonical order.
  expect(
    filterLabel({
      hideOwned: true,
      showNsfw: true,
      showIgnored: true,
      requirements: ["open"],
      designer: "aaaaa-aa",
      search: "moon",
      sort: "title",
    }),
  ).toBe(
    "Ignored chips · Chips I don't own · Swaps freely · one designer · " +
      "\u201Cmoon\u201D · NSFW shown",
  );
});

// A search longer than the ceiling says nothing a shorter one does not, and an
// empty market is a worse answer than a shorter search, so it is cut to fit
// rather than refused.
test("a search past the ceiling is cut to it rather than refused", () => {
  const long = "a".repeat(MAX_SEARCH_CHARS + 10);
  expect(normalizedSearch(long)).toHaveLength(MAX_SEARCH_CHARS);
});

// An empty grid has to say why it is empty. "Nothing here yet, add designers"
// is the wrong answer when the chips are there and the reader put them out of
// sight themselves — it makes a filtered market look like a broken one.
test("an empty market says the chips were ignored rather than missing", () => {
  expect(emptyMarketMessage(defaultFilter(), 3)).toBe(
    "Every chip that matched is one you ignored. Tick \u201CShow ignored chips\u201D to see them.",
  );
  expect(emptyMarketMessage(defaultFilter(), 1)).toBe(
    "Every chip that matched is one you ignored. Tick \u201CShow ignored chips\u201D to see it.",
  );
});

test("an empty ignored list says it is empty rather than filtered", () => {
  expect(emptyMarketMessage({ ...defaultFilter(), showIgnored: true }, 0)).toBe(
    "You have not ignored any chips. Ignore one from a card in the market and it will be here.",
  );
});

// Reviewing the ignored list with a search in the box is a different miss, and
// telling the reader they have ignored nothing would be plainly untrue.
test("a narrowed ignored list blames the filters rather than the list", () => {
  expect(
    emptyMarketMessage(
      { ...defaultFilter(), showIgnored: true, search: "moon" },
      0,
    ),
  ).toBe("No chip you ignored matches these filters. Widen them to see the rest.");
});

test("an empty market with nothing ignored reads as it always did", () => {
  expect(emptyMarketMessage(defaultFilter(), 0)).toBe(
    "Nothing here yet. Add designers in the Directory, then refresh catalogs to see what they have published.",
  );
  expect(emptyMarketMessage({ ...defaultFilter(), search: "moon" }, 0)).toBe(
    "No chip matches these filters. Widen them, or clear them to see the whole market.",
  );
});
