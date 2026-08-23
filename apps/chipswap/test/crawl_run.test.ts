import { expect, test } from "bun:test";
import { MAX_CRAWL_CONCURRENCY, MAX_DIRECTORY } from "../src/resident/crawl.ts";
import {
  MAX_FOUND_BATCH,
  startCrawl,
  type CrawlDeps,
} from "../src/resident/crawl_run.ts";
import type { DirectoryFetch } from "../src/resident/agent.ts";

// The loop, with the network and the canister replaced by functions. What is
// being checked here is not the walk — test/crawl.test.ts has that — but the
// promise the loop makes to the owner: whatever it found reaches the backend,
// on every way out of the loop there is.

const SELF = "self";

type Pages = Record<string, string[][]>;

/** A peer that hands over the pages listed for it, then nothing. */
function peer(pages: Pages) {
  return async (designer: string, offset: number): Promise<DirectoryFetch> => {
    const owned = pages[designer] ?? [];
    const index = offset === 0 ? 0 : offset;
    const entries = owned[index] ?? [];
    return { page: { entries, total: entries.length } };
  };
}

type Recorder = {
  deps: CrawlDeps;
  committed: string[][];
};

function deps(options: {
  eligible: string[];
  known?: string[];
  pages?: Pages;
  fetchPage?: CrawlDeps["fetchPage"];
  commit?: CrawlDeps["commit"];
}): Recorder {
  const committed: string[][] = [];
  return {
    committed,
    deps: {
      loadDirectory: async () => ({
        self: SELF,
        eligible: options.eligible,
        known: options.known ?? options.eligible,
      }),
      fetchPage: options.fetchPage ?? peer(options.pages ?? {}),
      commit:
        options.commit ??
        (async (canisters) => {
          committed.push(canisters);
          return { added: canisters.length, skipped: 0, full: false };
        }),
    },
  };
}

test("a crawl that finishes commits everything it found", async () => {
  const recorder = deps({
    eligible: ["alice"],
    pages: { alice: [["bob", "carol"]] },
  });
  const outcome = await startCrawl(recorder.deps).finished;

  expect(recorder.committed).toHaveLength(1);
  expect(recorder.committed[0].sort()).toEqual(["bob", "carol"]);
  expect(outcome.committed).toBe(true);
  expect(outcome.added).toBe(2);
  expect(outcome.active).toBe(false);
});

test("a crawl that found nobody makes no update call at all", async () => {
  const recorder = deps({ eligible: ["alice"], pages: { alice: [[]] } });
  const outcome = await startCrawl(recorder.deps).finished;

  // An empty batch is an update call that changes nothing and costs cycles.
  expect(recorder.committed).toHaveLength(0);
  expect(outcome.committed).toBe(true);
  expect(outcome.added).toBe(0);
});

test("the walk reaches designers it learned about along the way", async () => {
  const recorder = deps({
    eligible: ["alice"],
    pages: { alice: [["bob"]], bob: [["carol"]] },
  });
  const outcome = await startCrawl(recorder.deps).finished;

  expect(recorder.committed[0].sort()).toEqual(["bob", "carol"]);
  expect(outcome.queried).toBe(3);
});

test("a stopped crawl commits what it had found by then", async () => {
  let released: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    released = resolve;
  });
  let calls = 0;

  const recorder = deps({
    eligible: ["alice", "bob"],
    async fetchPage(designer): Promise<DirectoryFetch> {
      calls += 1;
      if (calls > 1) await gate;
      return { page: { entries: [`${designer}-friend`], total: 1 } };
    },
  });

  const handle = startCrawl(recorder.deps);
  // Let the first round land, then stop while the next is still in flight.
  while (calls === 0) await Promise.resolve();
  handle.stop();
  released?.();
  const outcome = await handle.finished;

  expect(outcome.committed).toBe(true);
  expect(recorder.committed).toHaveLength(1);
  // Stopping is not discarding. Whatever it had, the backend gets.
  expect(recorder.committed[0].length).toBeGreaterThan(0);
});

test("a crawl whose peer calls throw still commits what it found", async () => {
  let calls = 0;
  const recorder = deps({
    eligible: ["alice"],
    async fetchPage(): Promise<DirectoryFetch> {
      calls += 1;
      if (calls === 1) return { page: { entries: ["bob"], total: 1 } };
      // A gateway that falls over mid-walk.
      throw new Error("gateway exploded");
    },
  });

  const outcome = await startCrawl(recorder.deps).finished;

  // The found set survives the failure that ended the crawl.
  expect(recorder.committed[0]).toEqual(["bob"]);
  expect(outcome.error).toContain("gateway exploded");
  expect(outcome.committed).toBe(true);
});

test("a commit that fails is reported rather than swallowed", async () => {
  const recorder = deps({
    eligible: ["alice"],
    pages: { alice: [["bob"]] },
    commit: async () => {
      throw new Error("canister refused");
    },
  });
  const outcome = await startCrawl(recorder.deps).finished;

  expect(outcome.committed).toBe(false);
  expect(outcome.error).toContain("canister refused");
  // The finds are still counted, so the owner is not told the crawl was empty.
  expect(outcome.found).toBe(1);
});

test("the backend's own accounting is what gets reported, not the crawl's", async () => {
  const recorder = deps({
    eligible: ["alice"],
    pages: { alice: [["bob", "carol", "dave"]] },
    commit: async () => ({ added: 1, skipped: 2, full: true }),
  });
  const outcome = await startCrawl(recorder.deps).finished;

  // Three found, one seated. Reporting three would be a directory the owner
  // does not have.
  expect(outcome.found).toBe(3);
  expect(outcome.added).toBe(1);
  expect(outcome.skipped).toBe(2);
  expect(outcome.full).toBe(true);
});

test("no more than the round size is in flight at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const eligible = Array.from({ length: 40 }, (_, index) => `peer-${index}`);

  const recorder = deps({
    eligible,
    async fetchPage(): Promise<DirectoryFetch> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { page: { entries: [], total: 0 } };
    },
  });

  await startCrawl(recorder.deps).finished;
  // A forty-designer directory must not open forty sockets at once.
  expect(peak).toBeLessThanOrEqual(MAX_CRAWL_CONCURRENCY);
});

test("a peer on an older release is counted, not struck", async () => {
  const recorder = deps({
    eligible: ["alice", "bob"],
    async fetchPage(designer): Promise<DirectoryFetch> {
      if (designer === "alice") return { error: "unauthorized" };
      return { page: { entries: [], total: 0 } };
    },
  });
  const outcome = await startCrawl(recorder.deps).finished;

  expect(outcome.outdated).toBe(1);
  expect(outcome.queried).toBe(2);
});

test("a whole crawl fits in one batch, however many peers list", async () => {
  const crowd = Array.from(
    { length: MAX_FOUND_BATCH + 200 },
    (_, index) => `stranger-${index}`,
  );
  const recorder = deps({
    eligible: ["alice"],
    async fetchPage(designer): Promise<DirectoryFetch> {
      if (designer !== "alice") return { page: { entries: [], total: 0 } };
      return { page: { entries: crowd, total: crowd.length } };
    },
  });

  const outcome = await startCrawl(recorder.deps).finished;

  // The walk stops finding at MAX_DIRECTORY, and the backend accepts a batch
  // of exactly that size, so a crawl can never outgrow one call. This is the
  // assertion that keeps those two constants tied together: separate them and
  // a crawl starts losing its finds to `too_many`.
  expect(MAX_FOUND_BATCH).toBe(MAX_DIRECTORY);
  expect(recorder.committed).toHaveLength(1);
  expect(recorder.committed[0].length).toBeLessThanOrEqual(MAX_FOUND_BATCH);
  // Everything past the ceiling was never adopted, so it is not in `found`
  // either: the crawl does not carry designers it has nowhere to put.
  expect(outcome.found).toBe(MAX_DIRECTORY - 1);
  expect(outcome.full).toBe(true);
});

test("progress is readable while the crawl is still running", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recorder = deps({
    eligible: ["alice"],
    async fetchPage(): Promise<DirectoryFetch> {
      await gate;
      return { page: { entries: [], total: 0 } };
    },
  });

  const handle = startCrawl(recorder.deps);
  await Promise.resolve();
  expect(handle.progress().active).toBe(true);
  release?.();
  await handle.finished;
  expect(handle.progress().active).toBe(false);
});
