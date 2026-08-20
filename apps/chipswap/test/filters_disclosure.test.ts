import { expect, test } from "bun:test";
import { compileAsync } from "sass";

const styleUrl = new URL("../src/style.scss", import.meta.url);
const marketUrl = new URL("../src/views/market.tsx", import.meta.url);

// The filter grid sets its own `display`, which beats the user agent's
// `[hidden] { display: none }`. Without a matching guard the disclosure's
// `hidden` attribute toggles nothing and the filters stay on screen.
test("the collapsed filter grid stays hidden", async () => {
  const { css } = await compileAsync(styleUrl.pathname, {
    loadPaths: [new URL("../../../node_modules/", import.meta.url).pathname],
  });

  const guard = css.match(/\.chipswap-filter-grid\[hidden\]\s*\{[^}]*\}/);
  expect(guard?.[0]).toMatch(/display:\s*none/);
});

test("market filters start collapsed", async () => {
  const source = await Bun.file(marketUrl.pathname).text();

  expect(source).toContain("const [filtersOpen, setFiltersOpen] = useState(false);");
  expect(source).toContain("hidden={!filtersOpen}");
});
