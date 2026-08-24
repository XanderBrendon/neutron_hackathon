import { expect, test } from "bun:test";
import {
  MARKET_FILTER_KEY,
  readStoredFilter,
  writeStoredFilter,
} from "../src/market_filter_store.ts";
import { defaultFilter, type MarketFilter } from "../src/market_filter.ts";

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(seed));
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

/** A browser that refuses storage: reaching for either side throws. */
function hostileStorage(): Storage {
  return {
    get length(): number {
      throw new Error("denied");
    },
    clear: () => {
      throw new Error("denied");
    },
    getItem: () => {
      throw new Error("denied");
    },
    key: () => {
      throw new Error("denied");
    },
    removeItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
}

const narrowed: MarketFilter = {
  hideOwned: true,
  showNsfw: true,
  requirements: ["open", "approval"],
  designer: "aaaaa-aa",
  search: "moon",
  sort: "title",
};

test("a filter comes back the way it was left", () => {
  const store = fakeStorage();
  writeStoredFilter(narrowed, store);
  expect(readStoredFilter(store)).toEqual(narrowed);
});

test("a browser with nothing stored opens on the default", () => {
  expect(readStoredFilter(fakeStorage())).toEqual(defaultFilter());
});

// An absent key already means the default, so writing one would only leave
// something behind to disagree with a later default.
test("the default is remembered by storing nothing at all", () => {
  const store = fakeStorage();
  writeStoredFilter(narrowed, store);
  expect(store.getItem(MARKET_FILTER_KEY)).not.toBeNull();

  writeStoredFilter(defaultFilter(), store);
  expect(store.getItem(MARKET_FILTER_KEY)).toBeNull();
  expect(readStoredFilter(store)).toEqual(defaultFilter());
});

test("something that is not JSON leaves the market on its default", () => {
  const store = fakeStorage({ [MARKET_FILTER_KEY]: "{not json" });
  expect(readStoredFilter(store)).toEqual(defaultFilter());
});

test("JSON that is not a filter leaves the market on its default", () => {
  expect(
    readStoredFilter(fakeStorage({ [MARKET_FILTER_KEY]: '"moon"' })),
  ).toEqual(defaultFilter());
  expect(readStoredFilter(fakeStorage({ [MARKET_FILTER_KEY]: "[]" }))).toEqual(
    defaultFilter(),
  );
  expect(readStoredFilter(fakeStorage({ [MARKET_FILTER_KEY]: "null" }))).toEqual(
    defaultFilter(),
  );
});

// The market is worth more than the memory of it: a browser that refuses
// storage should cost the reader the filter, not the page.
test("a browser that refuses storage costs the filter and nothing else", () => {
  const store = hostileStorage();
  expect(readStoredFilter(store)).toEqual(defaultFilter());
  expect(() => writeStoredFilter(narrowed, store)).not.toThrow();
});

test("no storage to read at all is the default rather than a failure", () => {
  expect(readStoredFilter(null)).toEqual(defaultFilter());
  expect(() => writeStoredFilter(narrowed, null)).not.toThrow();
});

// The market only reads what it wrote, so nothing else in the browser's
// storage should move when a filter is saved or cleared.
test("saving a filter leaves the rest of storage alone", () => {
  const store = fakeStorage({ "chipswap.other": "kept" });
  writeStoredFilter(narrowed, store);
  writeStoredFilter(defaultFilter(), store);
  expect(store.getItem("chipswap.other")).toBe("kept");
});
