import { expect, test } from "bun:test";
import {
  DESIGNER_OPTIONS,
  NSFW_OPTIONS,
  OWNERSHIP_OPTIONS,
  POLICY_OPTIONS,
  defaultFilter,
  filterLabel,
  isDefaultFilter,
  serializeFilter,
} from "../src/store_filter.ts";

test("the store opens unfiltered, except that tagged chips wait to be asked for", () => {
  const filter = defaultFilter();
  expect(filter).toEqual({
    ownership: "all",
    designerOwnership: "all",
    policy: "all",
    nsfw: "hide",
  });
  expect(isDefaultFilter(filter)).toBe(true);
  expect(isDefaultFilter({ ...filter, nsfw: "show" })).toBe(false);
});

test("the four axes offer exactly the documented choices", () => {
  expect(OWNERSHIP_OPTIONS.map((option) => option.value)).toEqual([
    "all",
    "owned",
    "not_owned",
  ]);
  expect(DESIGNER_OPTIONS.map((option) => option.value)).toEqual([
    "all",
    "owner_of_designer",
    "not_owner_of_designer",
  ]);
  expect(POLICY_OPTIONS.map((option) => option.value)).toEqual([
    "all",
    "open",
    "approval",
    "requirements",
  ]);
  expect(NSFW_OPTIONS.map((option) => option.value)).toEqual(["hide", "show"]);
});

test("serialization uses the backend field names", () => {
  expect(
    serializeFilter({
      ownership: "owned",
      designerOwnership: "not_owner_of_designer",
      policy: "requirements",
      nsfw: "show",
    }),
  ).toEqual({
    ownership: "owned",
    designer_ownership: "not_owner_of_designer",
    policy: "requirements",
    nsfw: "show",
  });
  expect(Object.keys(serializeFilter(defaultFilter()))).toEqual([
    "ownership",
    "designer_ownership",
    "policy",
    "nsfw",
  ]);
});

test("the label names only the axes that are narrowing the view", () => {
  expect(filterLabel(defaultFilter())).toBe("Everything in your directory");
  expect(
    filterLabel({
      ownership: "not_owned",
      designerOwnership: "all",
      policy: "open",
      nsfw: "hide",
    }),
  ).toBe("Chips I don't own · Swaps freely");
  // Showing tagged chips widens the view rather than narrowing it, so it is the
  // one setting worth naming when it is not the default.
  expect(
    filterLabel({
      ownership: "all",
      designerOwnership: "all",
      policy: "all",
      nsfw: "show",
    }),
  ).toBe("NSFW shown");
});
