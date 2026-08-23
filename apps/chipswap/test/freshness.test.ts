import { expect, test } from "bun:test";
import { staleDesigners } from "../src/resident/freshness.ts";
import type { CachedCatalog } from "../src/resident/store.ts";

// The TTL rule, away from IndexedDB and the network. What counts as stale is
// the whole policy, so it is a function over a clock rather than a timer.

const TTL = 86_400_000;
const NOW = 1_700_000_000_000;

function entry(designer: string, fetchedAtMs: number): CachedCatalog {
  return { designer, designs: [], fetchedAtMs, lastError: null };
}

test("a designer with no cache at all is stale", () => {
  expect(staleDesigners(["alice"], [], NOW, TTL)).toEqual(["alice"]);
});

test("a designer fetched inside the window is left alone", () => {
  expect(staleDesigners(["alice"], [entry("alice", NOW - TTL + 1)], NOW, TTL)).toEqual(
    [],
  );
});

test("a designer fetched exactly at the window is stale", () => {
  expect(staleDesigners(["alice"], [entry("alice", NOW - TTL)], NOW, TTL)).toEqual([
    "alice",
  ]);
});

test("a designer whose last attempt failed is stale even inside the window", () => {
  // A peer still on caller "canister" lands here. Asking again next time the
  // market opens is how they rejoin it the day they upgrade.
  const cached: CachedCatalog[] = [
    {
      designer: "alice",
      designs: [],
      fetchedAtMs: NOW - 1_000,
      lastError: "unauthorized",
    },
  ];
  expect(staleDesigners(["alice"], cached, NOW, TTL)).toEqual(["alice"]);
});

test("an entry that has never successfully fetched is stale", () => {
  expect(staleDesigners(["alice"], [entry("alice", 0)], NOW, TTL)).toEqual(["alice"]);
});

test("only the stale members of a mixed set are returned, in input order", () => {
  const cached = [entry("alice", NOW - 1_000), entry("carol", NOW - TTL - 1)];
  expect(staleDesigners(["alice", "bob", "carol"], cached, NOW, TTL)).toEqual([
    "bob",
    "carol",
  ]);
});

test("a cached designer nobody asked about is not refreshed", () => {
  // The caller names the directory; the cache may hold designers who have
  // since left it, and those are evicted rather than re-fetched.
  expect(staleDesigners(["alice"], [entry("dave", 0)], NOW, TTL)).toEqual(["alice"]);
});

test("a clock that jumped backwards does not make a fresh entry stale", () => {
  // A stamp in the future is a clock fault, not freshness to distrust.
  // Refetching on every open would be a loop rather than a correction.
  expect(staleDesigners(["alice"], [entry("alice", NOW + 60_000)], NOW, TTL)).toEqual(
    [],
  );
});

test("an empty ask is an empty answer", () => {
  expect(staleDesigners([], [entry("alice", 0)], NOW, TTL)).toEqual([]);
});

test("a repeated designer is not asked for twice", () => {
  // The directory should not contain duplicates, but a refresh that opened two
  // sockets to one peer because it did would be this function's fault.
  expect(staleDesigners(["alice", "alice"], [], NOW, TTL)).toEqual(["alice"]);
});
