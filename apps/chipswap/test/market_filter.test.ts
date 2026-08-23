import { expect, test } from "bun:test";
import {
  REQUIREMENT_FACETS,
  SORT_OPTIONS,
  MAX_SEARCH_CHARS,
  defaultFilter,
  filterLabel,
  canonicalFacets,
  isDefaultFilter,
  normalizedSearch,
  toggleFacet,
} from "../src/market_filter.ts";

test("the market opens with owned chips and tagged chips already out of the way", () => {
  const filter = defaultFilter();
  expect(filter).toEqual({
    hideOwned: true,
    showNsfw: false,
    requirements: [],
    designer: null,
    search: "",
    sort: "recent",
  });
  expect(isDefaultFilter(filter)).toBe(true);
});

test("any axis moved off its default is no longer the default", () => {
  const filter = defaultFilter();
  expect(isDefaultFilter({ ...filter, hideOwned: false })).toBe(false);
  expect(isDefaultFilter({ ...filter, showNsfw: true })).toBe(false);
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
  expect(filterLabel(defaultFilter())).toBe("Chips I don't own");
  expect(
    filterLabel({ ...defaultFilter(), hideOwned: false, sort: "title" }),
  ).toBe("Everything in your directory");
  // Named in the facet order, not the order they were ticked, so one set of
  // choices always reads as one sentence.
  expect(
    filterLabel({ ...defaultFilter(), requirements: ["open", "tradeable"] }),
  ).toBe("Chips I don't own · Trades I can make or Swaps freely");
  expect(filterLabel({ ...defaultFilter(), search: "moon" })).toBe(
    "Chips I don't own · \u201Cmoon\u201D",
  );
  expect(filterLabel({ ...defaultFilter(), designer: "aaaaa-aa" })).toBe(
    "Chips I don't own · one designer",
  );
  // Showing tagged chips widens the view rather than narrowing it, so it is
  // the one setting worth naming when it is not the default.
  expect(filterLabel({ ...defaultFilter(), showNsfw: true })).toBe(
    "Chips I don't own · NSFW shown",
  );
});

// A search longer than the ceiling says nothing a shorter one does not, and an
// empty market is a worse answer than a shorter search, so it is cut to fit
// rather than refused.
test("a search past the ceiling is cut to it rather than refused", () => {
  const long = "a".repeat(MAX_SEARCH_CHARS + 10);
  expect(normalizedSearch(long)).toHaveLength(MAX_SEARCH_CHARS);
});
