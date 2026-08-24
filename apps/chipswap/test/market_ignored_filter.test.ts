import { expect, test } from "bun:test";

const marketUrl = new URL("../src/views/market.tsx", import.meta.url);

const source = () => Bun.file(marketUrl.pathname).text();

// The axis is reachable or it is not a feature. These are source checks because
// mounting the Market means the canister and the background behind it; what the
// filter and the card actually do is pinned in market_page and market_card.

test("the market offers the ignored chips as a filter", async () => {
  const market = await source();

  expect(market).toContain('data-tid="chipswap-show-ignored"');
  expect(market).toContain("checked={filter.showIgnored}");
  expect(market).toContain("showIgnored");
});

// The whole point of the filter is that an ignored chip is still there to be
// found. A market that withheld chips without saying so would make them look
// missing rather than filtered — the same reason the tag tally is on screen.
test("the market says how many chips it withheld as ignored", async () => {
  const market = await source();

  expect(market).toContain("ignoredHidden");
  expect(market).toMatch(/ignoredHidden > 0/);
});

// One card, rendered from one component, so the grid and its tests cannot drift
// apart.
test("the grid renders the shared market card", async () => {
  const market = await source();

  expect(market).toContain("MarketCard");
  expect(market).toContain("onSetIgnored=");
  // The inline copy it replaced is gone rather than left behind beside it.
  expect(market).not.toContain("Trade for this");
});

test("turning a chip away goes through the canister", async () => {
  const market = await source();

  expect(market).toContain("setDesignIgnored");
});
