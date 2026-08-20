import { expect, test } from "bun:test";
import {
  REQUIREMENT_FACETS,
  SORT_OPTIONS,
  MAX_SEARCH_CHARS,
  defaultFilter,
  filterLabel,
  isDefaultFilter,
  serializeFilter,
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
// what the backend is asked or make two equal filters look different.
test("facets serialize in a fixed order however they were ticked", () => {
  expect(
    serializeFilter({ ...defaultFilter(), requirements: ["approval", "open"] })
      .requirements,
  ).toEqual(["open", "approval"]);
});

test("serialization uses the backend field names", () => {
  expect(
    serializeFilter({
      hideOwned: true,
      showNsfw: true,
      requirements: ["tradeable", "min_colors"],
      designer: "aaaaa-aa",
      search: "  Moon  ",
      sort: "title",
    }),
  ).toEqual({
    ownership: "not_owned",
    nsfw: "show",
    requirements: ["tradeable", "min_colors"],
    designer: "aaaaa-aa",
    search: "Moon",
    sort: "title",
  });
});

// The two checkbox axes are the ones whose wire values are not the word the
// reader saw, so each is worth pinning in both positions.
test("the checkboxes map onto the ownership and tag axes the backend knows", () => {
  const shown = serializeFilter({ ...defaultFilter(), hideOwned: false, showNsfw: true });
  expect(shown.ownership).toBe("all");
  expect(shown.nsfw).toBe("show");
  const hidden = serializeFilter(defaultFilter());
  expect(hidden.ownership).toBe("not_owned");
  expect(hidden.nsfw).toBe("hide");
});

test("a search of nothing but spaces asks the backend for nothing", () => {
  expect(serializeFilter({ ...defaultFilter(), search: "   " }).search).toBe("");
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

test("no designer picked asks the backend about every designer", () => {
  expect(serializeFilter(defaultFilter()).designer).toBe("");
});

// The backend refuses a search past its ceiling rather than truncating it, and
// an empty market is a worse answer than a shorter search, so the ceiling is
// applied here too.
test("a search past the backend ceiling is cut to it rather than refused", () => {
  const long = "a".repeat(MAX_SEARCH_CHARS + 10);
  expect(serializeFilter({ ...defaultFilter(), search: long }).search).toHaveLength(
    MAX_SEARCH_CHARS,
  );
});
