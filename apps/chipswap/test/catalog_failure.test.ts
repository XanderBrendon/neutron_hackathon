import { expect, test } from "bun:test";
import {
  failedDesigners,
  failureReason,
  type FailureDirectoryEntry,
} from "../src/catalog_failure.ts";
import type { CachedCatalog } from "../src/resident/store.ts";

// Which designers the Market names as having failed it, and in what terms.
//
// The facts come from the browser's own catalog cache: the background writes a
// `lastError` on every attempt that came back with nothing, and clears it on
// every attempt that did not. So this is the same list whether the fetch was
// the automatic one on opening the Market or the owner pressing Refresh.

const ALICE = "aaaaa-aa";
const BOB = "bbbbb-bb";
const CAROL = "ccccc-cc";

function known(
  canister: string,
  extra: Partial<FailureDirectoryEntry> = {},
): FailureDirectoryEntry {
  return { canister, ignored: false, contactName: null, ...extra };
}

function cached(
  designer: string,
  extra: Partial<CachedCatalog> = {},
): CachedCatalog {
  return { designer, designs: [], fetchedAtMs: 0, lastError: null, ...extra };
}

test("names a designer whose last fetch came back with nothing", () => {
  const failed = failedDesigners(
    [cached(ALICE, { lastError: "not_found" })],
    [known(ALICE, { contactName: "Ada" })],
  );

  expect(failed).toHaveLength(1);
  expect(failed[0]!.canister).toBe(ALICE);
  expect(failed[0]!.contactName).toBe("Ada");
});

test("says nothing about a designer whose catalog was read", () => {
  const failed = failedDesigners(
    [cached(ALICE, { fetchedAtMs: 5 })],
    [known(ALICE)],
  );

  expect(failed).toEqual([]);
});

test("leaves out an ignored designer, who is not being asked at all", () => {
  const failed = failedDesigners(
    [cached(ALICE, { lastError: "not_found" })],
    [known(ALICE, { ignored: true })],
  );

  expect(failed).toEqual([]);
});

test("leaves out a cached designer the owner has since removed", () => {
  const failed = failedDesigners([cached(ALICE, { lastError: "busy" })], []);

  expect(failed).toEqual([]);
});

test("carries the last successful read, so the view can say whether their chips are still on screen", () => {
  const [never, stocked] = failedDesigners(
    [
      cached(ALICE, { lastError: "busy" }),
      cached(BOB, { fetchedAtMs: 1700, lastError: "busy" }),
    ],
    [known(ALICE), known(BOB)],
  );

  expect(never!.lastFetchedAtMs).toBe(0);
  expect(stocked!.lastFetchedAtMs).toBe(1700);
});

test("follows the directory's order rather than the cache's", () => {
  const failed = failedDesigners(
    [
      cached(CAROL, { lastError: "busy" }),
      cached(ALICE, { lastError: "busy" }),
      cached(BOB, { lastError: "busy" }),
    ],
    [known(ALICE), known(BOB), known(CAROL)],
  );

  expect(failed.map((entry) => entry.canister)).toEqual([ALICE, BOB, CAROL]);
});

// A peer that has not taken the release opening `catalog` to browsers refuses
// the query outright. Saying so is the whole point: an owner told only that
// somebody "did not answer" would remove a designer who is merely behind.
test("separates a designer who has not upgraded from one who is gone", () => {
  expect(failureReason("unauthorized")).toBe(
    "is on an older release, so their catalog cannot be read from a browser yet",
  );
  expect(failureReason("not_found")).toBe(
    "answered nothing on the catalog route, so they may have uninstalled Chipswap",
  );
});

test("says which failures are the peer being busy rather than gone", () => {
  expect(failureReason("busy")).toBe("was too busy to answer");
  expect(failureReason("rate_limited")).toBe("was too busy to answer");
  expect(failureReason("low_cycles")).toBe("is out of cycles");
});

test("says when the peer answered but we could not read it", () => {
  const unreadable = "answered with something this version of Chipswap cannot read";
  expect(failureReason("undecodable")).toBe(unreadable);
  expect(failureReason("malformed_reply")).toBe(unreadable);
  expect(failureReason("malformed_envelope")).toBe(unreadable);
});

// The background records the exception's own message when a call throws, so
// the codes below are a known subset rather than the whole space.
test("falls back to silence for a code it does not recognise", () => {
  expect(failureReason("Call failed: no response")).toBe("did not answer");
  expect(failureReason("")).toBe("did not answer");
});

test("gives every named designer a reason", () => {
  const failed = failedDesigners(
    [cached(ALICE, { lastError: "unauthorized" })],
    [known(ALICE)],
  );

  expect(failed[0]!.reason).toBe(failureReason("unauthorized"));
});
