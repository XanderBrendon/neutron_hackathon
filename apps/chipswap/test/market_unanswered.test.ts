import { expect, test } from "bun:test";
import { compileAsync } from "sass";

const styleUrl = new URL("../src/style.scss", import.meta.url);
const marketUrl = new URL("../src/views/market.tsx", import.meta.url);

// The Market names the designers that did not answer and offers the two things
// worth doing about it. What decides *which* designers those are is
// catalog_failure.ts, which is tested on its own; what this file guards is that
// the answer reaches the owner where they can act on it.

async function marketSource(): Promise<string> {
  return Bun.file(marketUrl.pathname).text();
}

// Above the filters, not inside them. The filters are collapsed by default, and
// a notice the owner has to open a disclosure to find is a notice about a
// designer whose chips quietly stopped arriving.
test("the unanswered notice sits above the collapsed filters", async () => {
  const source = await marketSource();

  const notice = source.indexOf('data-tid="chipswap-unanswered"');
  const filters = source.indexOf('className="nt-disclosure chipswap-filters"');
  expect(notice).toBeGreaterThan(-1);
  expect(filters).toBeGreaterThan(-1);
  expect(notice).toBeLessThan(filters);
});

test("each named designer carries both decisions", async () => {
  const source = await marketSource();

  expect(source).toContain('void decide(entry.canister, "ignore")');
  expect(source).toContain('void decide(entry.canister, "remove")');
});

// Both endings evict the cached catalog. It is what put the designer on the
// list, so one left behind would keep naming somebody already dealt with — and
// a removed designer's chips must not outlive their directory entry.
test("deciding takes the cached catalog with it", async () => {
  const source = await marketSource();

  const decide = source.slice(
    source.indexOf("const decide = async"),
    source.indexOf("// Only a designer with something cached"),
  );
  expect(decide).toContain("setDirectoryIgnored(canister, true)");
  expect(decide).toContain("removeDirectoryEntry(canister)");
  expect(decide).toContain("evictCatalogs([canister])");
});

// The row puts the name and the reason against the buttons. Without the layout
// rule the two collapse into one run of text, and the reason is the thing the
// buttons are being chosen between.
test("the notice rows lay the reason out against the buttons", async () => {
  const { css } = await compileAsync(styleUrl.pathname, {
    loadPaths: [new URL("../../../node_modules/", import.meta.url).pathname],
  });

  const row = css.match(/\.chipswap-unanswered-list li\s*\{[^}]*\}/);
  expect(row?.[0]).toMatch(/justify-content:\s*space-between/);
  expect(css).toContain(".chipswap-unanswered-who");
});
