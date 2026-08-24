import { expect, test } from "bun:test";
import { Glob } from "bun";

const srcDir = new URL("../src/", import.meta.url).pathname;
const marketUrl = new URL("../src/views/market.tsx", import.meta.url);
const shellUrl = new URL("../src/index.tsx", import.meta.url);

// Only one view is mounted at a time, so a filter kept inside the Market is
// discarded the moment the reader looks at the Studio. The shell is what lasts
// as long as the tile does, so it is what holds the filter.
test("the shell holds the market filter and hands it down", async () => {
  const shell = await Bun.file(shellUrl.pathname).text();

  expect(shell).toContain(
    "const [marketFilter, setMarketFilter] = useState<MarketFilter>(defaultFilter);",
  );
  expect(shell).toContain("filter={marketFilter}");
  expect(shell).toContain("setFilter={setMarketFilter}");
});

test("the market takes the filter rather than owning it", async () => {
  const market = await Bun.file(marketUrl.pathname).text();

  expect(market).toContain(
    "export const Market = ({ status, onChanged, filter, setFilter }: Props) => {",
  );
  // A plain value would lose the amendments' guarantee that a change builds on
  // the current filter rather than on the one that render last saw.
  expect(market).toContain("setFilter: Dispatch<SetStateAction<MarketFilter>>;");
  expect(market).not.toContain("useState<MarketFilter>");
});

// The root cause of the first attempt at this: a tile frame is sandboxed
// `allow-scripts` with no `allow-same-origin`, so its origin is opaque and
// every storage API throws rather than persists. The failure is silent, which
// is what makes it worth a test — storage here looks like it works and
// remembers nothing. `src/resident/` is the background, which has a real
// origin and is the one place in this app that may keep something.
test("nothing in the tile reaches for browser storage", async () => {
  const offenders: string[] = [];
  for await (const path of new Glob("**/*.{ts,tsx}").scan(srcDir)) {
    if (path.startsWith("resident/")) continue;
    const source = await Bun.file(`${srcDir}${path}`).text();
    // Comments come out first: naming the thing to explain why it is absent is
    // the opposite of reaching for it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    if (/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(code)) {
      offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});
