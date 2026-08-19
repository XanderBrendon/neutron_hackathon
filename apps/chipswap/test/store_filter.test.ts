import { expect, test } from "bun:test";
import {
  DESIGNER_OPTIONS,
  OWNERSHIP_OPTIONS,
  TRADE_MODE_OPTIONS,
  defaultFilter,
  filterLabel,
  isDefaultFilter,
  serializeFilter,
} from "../src/store_filter.ts";

test("the store opens unfiltered", () => {
  const filter = defaultFilter();
  expect(filter).toEqual({
    ownership: "all",
    designerOwnership: "all",
    tradeMode: "all",
  });
  expect(isDefaultFilter(filter)).toBe(true);
});

test("the three axes offer exactly the documented choices", () => {
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
  expect(TRADE_MODE_OPTIONS.map((option) => option.value)).toEqual([
    "all",
    "auto",
    "manual",
  ]);
});

test("serialisation uses the backend field names", () => {
  expect(
    serializeFilter({
      ownership: "owned",
      designerOwnership: "not_owner_of_designer",
      tradeMode: "manual",
    }),
  ).toEqual({
    ownership: "owned",
    designer_ownership: "not_owner_of_designer",
    trade_mode: "manual",
  });
  expect(Object.keys(serializeFilter(defaultFilter()))).toEqual([
    "ownership",
    "designer_ownership",
    "trade_mode",
  ]);
});

test("the label names only the axes that are narrowing the view", () => {
  expect(filterLabel(defaultFilter())).toBe("Everything in your directory");
  expect(
    filterLabel({
      ownership: "not_owned",
      designerOwnership: "all",
      tradeMode: "auto",
    }),
  ).toBe("Chips I don't own · Accepts any trade");
});
