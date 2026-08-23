import { expect, test } from "bun:test";
import {
  CRAWL_PAGE,
  MAX_DIRECTORY,
  createCrawl,
  finishPeer,
  nextTargets,
  noteFailure,
  notePage,
  snapshot,
} from "../src/resident/crawl.ts";

// The walk that used to live in backend/Directory.mo. It is the same walk, so
// these are the same rules: what a peer's claimed total may and may not make
// us do, what a stale reply is worth, and which designers a crawl may add.
//
// Nothing here touches the network or the canister. That is the point of the
// module: the frontier is testable on its own, which it was not when half of
// it was in Motoko and half in a React loop.

const SELF = "3wvx3-yaaaa-aaaay-aacuq-cai";
const ALPHA = "233tv-xiaaa-aaaay-aacta-cai";
const BETA = "bkyz2-fmaaa-aaaaa-qaaaq-cai";
const GAMMA = "be2us-64aaa-aaaaa-qaabq-cai";
const DELTA = "br5f7-7uaaa-aaaaa-qaaca-cai";

function start(eligible: string[], known: string[] = eligible) {
  return createCrawl({ self: SELF, eligible, known });
}

/** Who the next round would call, by name. */
function asked(state: ReturnType<typeof start>): string[] {
  return nextTargets(state, MAX_DIRECTORY).map((target) => target.designer);
}

/** A page of `count` synthetic designers, distinct from the named ones. */
function strangers(count: number, from = 0): string[] {
  return Array.from({ length: count }, (_, index) =>
    // Valid principal text is not required by the walk; it never parses these.
    `stranger-${index + from}`,
  );
}

test("a new crawl's frontier is the eligible designers it was given", () => {
  const state = start([ALPHA, BETA]);
  expect(snapshot(state).remaining).toBe(2);
  expect(snapshot(state).queried).toBe(0);
  expect(snapshot(state).found).toBe(0);
});

test("this canister is never its own crawl target", () => {
  const state = start([ALPHA, SELF]);
  expect(nextTargets(state, 8).map((target) => target.designer)).toEqual([ALPHA]);
});

test("a target starts at offset zero", () => {
  const state = start([ALPHA]);
  expect(nextTargets(state, 8)).toEqual([{ designer: ALPHA, offset: 0 }]);
});

test("part-read peers are asked before untouched ones", () => {
  const state = start([ALPHA, BETA, GAMMA]);
  // BETA hands over a full page and is left part-read.
  notePage(state, BETA, 0, { entries: strangers(128), total: 500 });
  const targets = nextTargets(state, 8);
  // A long directory is finished rather than left behind newer work.
  expect(targets[0]).toEqual({ designer: BETA, offset: 128 });
});

test("no more than the limit is asked in one round", () => {
  const state = start([ALPHA, BETA, GAMMA, DELTA]);
  expect(nextTargets(state, 2)).toHaveLength(2);
});

test("a limit of zero asks nobody", () => {
  const state = start([ALPHA]);
  expect(nextTargets(state, 0)).toEqual([]);
});

test("a finished peer is never asked again", () => {
  const state = start([ALPHA, BETA]);
  finishPeer(state, ALPHA);
  expect(nextTargets(state, 8).map((target) => target.designer)).toEqual([BETA]);
  expect(snapshot(state).queried).toBe(1);
  expect(snapshot(state).remaining).toBe(1);
});

test("a page shorter than the one we asked for is the end of a directory", () => {
  const state = start([ALPHA]);
  // The peer claims 900 entries and sends one. `served` never does that, so
  // the short page is believed over the total they assert.
  notePage(state, ALPHA, 0, { entries: [BETA], total: 900 });
  expect(snapshot(state).queried).toBe(1);
  expect(asked(state)).not.toContain(ALPHA);
});

test("an empty page finishes the peer", () => {
  const state = start([ALPHA]);
  notePage(state, ALPHA, 0, { entries: [], total: 0 });
  expect(snapshot(state).queried).toBe(1);
});

test("a page that reaches the peer's total finishes them", () => {
  const state = start([ALPHA]);
  notePage(state, ALPHA, 0, { entries: strangers(128), total: 128 });
  expect(snapshot(state).queried).toBe(1);
  // The 128 they named are now the frontier; the peer who named them is not.
  expect(asked(state)).not.toContain(ALPHA);
});

test("a full page below the total advances the cursor", () => {
  const state = start([ALPHA]);
  notePage(state, ALPHA, 0, { entries: strangers(128), total: 300 });
  expect(snapshot(state).queried).toBe(0);
  // Part-read, so they lead the next round rather than joining its tail.
  expect(nextTargets(state, 8)[0]).toEqual({ designer: ALPHA, offset: 128 });
});

test("a reply for an offset we did not ask for is discarded", () => {
  const state = start([ALPHA]);
  notePage(state, ALPHA, 0, { entries: strangers(128), total: 300 });
  // A reply describing a position in a walk we are no longer at.
  const added = notePage(state, ALPHA, 0, { entries: [BETA], total: 300 });
  expect(added).toBe(0);
  expect(snapshot(state).found).toBe(128);
});

test("a reply from a peer already finished is discarded", () => {
  const state = start([ALPHA]);
  finishPeer(state, ALPHA);
  expect(notePage(state, ALPHA, 0, { entries: [BETA], total: 1 })).toBe(0);
  expect(snapshot(state).found).toBe(0);
});

test("a discovered designer joins both the frontier and the found set", () => {
  const state = start([ALPHA]);
  notePage(state, ALPHA, 0, { entries: [BETA, GAMMA], total: 2 });
  expect(snapshot(state).found).toBe(2);
  // Discovered designers are crawled onward: that is what makes it a crawl.
  expect(nextTargets(state, 8).map((target) => target.designer).sort()).toEqual(
    [BETA, GAMMA].sort(),
  );
});

test("a designer the backend already knows is not counted as found", () => {
  const state = start([ALPHA, BETA]);
  notePage(state, ALPHA, 0, { entries: [BETA], total: 1 });
  // BETA was already in the directory, so there is nothing to commit for them.
  expect(snapshot(state).found).toBe(0);
});

test("a designer the owner ignored is not crawled back in", () => {
  // GAMMA is known to the backend but not eligible: ignored or retired.
  const state = start([ALPHA], [ALPHA, GAMMA]);
  notePage(state, ALPHA, 0, { entries: [GAMMA], total: 1 });
  expect(snapshot(state).found).toBe(0);
  // Withholding is the whole of what ignoring means. A crawl must not undo it.
  expect(nextTargets(state, 8)).toEqual([]);
});

test("a peer offering us our own address is not believed", () => {
  const state = start([ALPHA]);
  notePage(state, ALPHA, 0, { entries: [SELF], total: 1 });
  expect(snapshot(state).found).toBe(0);
  expect(nextTargets(state, 8)).toEqual([]);
});

test("the same designer found twice is counted once", () => {
  const state = start([ALPHA, BETA]);
  notePage(state, ALPHA, 0, { entries: [GAMMA], total: 1 });
  notePage(state, BETA, 0, { entries: [GAMMA], total: 1 });
  expect(snapshot(state).found).toBe(1);
});

test("a peer inventing a huge total is stopped at the directory ceiling", () => {
  const state = start([ALPHA]);
  let rounds = 0;
  let offset = 0;
  // Claims four billion entries and keeps handing over full pages, so neither
  // the short-page rule nor the total will ever stop them. The ceiling must.
  while (asked(state).includes(ALPHA) && rounds < 100) {
    notePage(state, ALPHA, offset, {
      entries: strangers(128, offset),
      total: 4_000_000_000,
    });
    offset += 128;
    rounds += 1;
  }
  expect(rounds).toBe(MAX_DIRECTORY / CRAWL_PAGE);
  expect(snapshot(state).queried).toBe(1);
});

test("a peer dribbling one entry per page is finished in one round", () => {
  const state = start([ALPHA]);
  notePage(state, ALPHA, 0, { entries: strangers(1), total: 4_000_000_000 });
  expect(snapshot(state).queried).toBe(1);
  expect(asked(state)).not.toContain(ALPHA);
});

test("the found set stops at the directory the backend can hold", () => {
  // 500 already known leaves room for 12 more.
  const known = strangers(500, 10_000);
  const state = start([ALPHA], [ALPHA, ...known]);
  notePage(state, ALPHA, 0, { entries: strangers(40), total: 40 });
  expect(snapshot(state).found).toBe(MAX_DIRECTORY - known.length - 1);
  expect(snapshot(state).full).toBe(true);
});

test("a crawl with room to spare does not claim the directory is full", () => {
  const state = start([ALPHA]);
  notePage(state, ALPHA, 0, { entries: [BETA], total: 1 });
  expect(snapshot(state).full).toBe(false);
});

test("a peer on an older release is counted as outdated, not as gone", () => {
  const state = start([ALPHA, BETA]);
  noteFailure(state, ALPHA, "unauthorized");
  const view = snapshot(state);
  expect(view.outdated).toBe(1);
  // They answered something. The crawl is a query, and a peer that has not
  // upgraded is not a peer who has uninstalled.
  expect(view.queried).toBe(1);
  expect(nextTargets(state, 8).map((target) => target.designer)).toEqual([BETA]);
});

test("any other failure finishes the peer without counting them outdated", () => {
  const state = start([ALPHA]);
  noteFailure(state, ALPHA, "unreachable");
  expect(snapshot(state).outdated).toBe(0);
  expect(snapshot(state).queried).toBe(1);
});

test("what a stopped crawl found is what it committed", () => {
  const state = start([ALPHA, BETA]);
  notePage(state, ALPHA, 0, { entries: [GAMMA, DELTA], total: 2 });
  // Stopping is the caller's business; the state simply reports its finds.
  expect([...state.found].sort()).toEqual([GAMMA, DELTA].sort());
});
