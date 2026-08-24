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
  parseFilter,
  toggleFacet,
} from "../src/market_filter.ts";

test("the market opens showing owned chips, with tagged chips out of the way", () => {
  const filter = defaultFilter();
  expect(filter).toEqual({
    hideOwned: false,
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
  expect(isDefaultFilter({ ...filter, hideOwned: true })).toBe(false);
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
  // Every axis at once still reads in the canonical order.
  expect(
    filterLabel({
      hideOwned: true,
      showNsfw: true,
      requirements: ["open"],
      designer: "aaaaa-aa",
      search: "moon",
      sort: "title",
    }),
  ).toBe("Chips I don't own · Swaps freely · one designer · \u201Cmoon\u201D · NSFW shown");
});

// The market's filter is kept in the browser between visits, so what comes back
// is whatever was under that key: this build's copy, an older build's, or
// something hand-edited.
test("a filter written by this build reads back unchanged", () => {
  const narrowed = {
    hideOwned: true,
    showNsfw: true,
    requirements: ["open", "approval"],
    designer: "aaaaa-aa",
    search: "moon",
    sort: "title",
  };
  expect(parseFilter(narrowed)).toEqual(narrowed);
});

test("anything that is not a filter at all reads as the default", () => {
  expect(parseFilter(null)).toEqual(defaultFilter());
  expect(parseFilter("moon")).toEqual(defaultFilter());
  expect(parseFilter([])).toEqual(defaultFilter());
  expect(parseFilter(undefined)).toEqual(defaultFilter());
  expect(parseFilter({})).toEqual(defaultFilter());
});

// One axis gone bad should not throw away the others: what is left is still
// mostly the choices the reader made.
test("an axis that will not read falls back on its own", () => {
  const parsed = parseFilter({
    hideOwned: "yes",
    showNsfw: true,
    requirements: "open",
    designer: 7,
    search: 12,
    sort: "sideways",
  });
  expect(parsed).toEqual({ ...defaultFilter(), showNsfw: true });
});

test("a facet this build does not know is dropped from the set", () => {
  expect(parseFilter({ requirements: ["open", "telepathy"] }).requirements).toEqual([
    "open",
  ]);
});

// Storage has no order and no notion of a set, so a stored copy can hold the
// facets shuffled or repeated and still mean one set of choices.
test("stored facets read back canonical however they were written", () => {
  expect(
    parseFilter({ requirements: ["approval", "open", "open"] }).requirements,
  ).toEqual(["open", "approval"]);
});

test("a stored search is trimmed and cut to the ceiling like a typed one", () => {
  expect(parseFilter({ search: "  moon  " }).search).toBe("moon");
  expect(
    parseFilter({ search: "a".repeat(MAX_SEARCH_CHARS + 10) }).search,
  ).toHaveLength(MAX_SEARCH_CHARS);
});

// An empty principal is nobody, which is what "every designer" already says.
test("an empty designer reads as no designer constraint", () => {
  expect(parseFilter({ designer: "" }).designer).toBeNull();
});

test("a stored filter that is already the default stays the default", () => {
  expect(parseFilter(defaultFilter())).toEqual(defaultFilter());
  expect(isDefaultFilter(parseFilter(defaultFilter()))).toBe(true);
});

// A search longer than the ceiling says nothing a shorter one does not, and an
// empty market is a worse answer than a shorter search, so it is cut to fit
// rather than refused.
test("a search past the ceiling is cut to it rather than refused", () => {
  const long = "a".repeat(MAX_SEARCH_CHARS + 10);
  expect(normalizedSearch(long)).toHaveLength(MAX_SEARCH_CHARS);
});
