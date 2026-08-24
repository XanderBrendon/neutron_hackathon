import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PIXEL_COUNT, encodePixels } from "../src/chip.ts";
import { MarketCard } from "../src/market_card.tsx";
import type { MarketRow } from "../src/market_page.ts";

const row = (overrides: Partial<MarketRow> = {}): MarketRow => ({
  designer: "aaaaa-aa",
  designId: 3,
  title: "Moonrise",
  art: {
    shapeId: "circle31",
    palette: ["#000000", "#7fd1c1"],
    pixels: encodePixels(new Uint8Array(PIXEL_COUNT).fill(1)),
  },
  requirements: {
    approval: false,
    minColors: null,
    maxCoverage: null,
    nsfw: "any",
  },
  nsfw: false,
  designRevision: "1",
  owned: false,
  ignored: false,
  fetchedAtMs: 1_700_000_000_000,
  contactName: null,
  ...overrides,
});

const render = (row: MarketRow, busy = false) =>
  renderToStaticMarkup(
    <MarketCard
      busy={busy}
      onSetIgnored={() => {}}
      onTrade={() => {}}
      row={row}
    />,
  );

test("an ordinary chip offers to be turned away", () => {
  const markup = render(row());

  expect(markup).toContain("Ignore");
  expect(markup).not.toContain("Unignore");
});

// The filter turns the Market into a list of what was turned away, so the one
// action worth offering there is the way back.
test("a chip already turned away offers the way back instead", () => {
  const markup = render(row({ ignored: true }));

  expect(markup).toContain("Unignore");
  // "Ignore" is a substring of "Unignore", so the check has to be for the
  // button that would put it away again rather than for the word.
  expect(markup).not.toContain(">Ignore<");
});

test("a chip that was turned away says so on its face", () => {
  expect(render(row({ ignored: true }))).toContain("ignored");
  expect(render(row())).not.toContain("ignored");
});

// A grid of cards is a row of identical buttons to a screen reader, so each
// one names the chip it acts on.
test("each action names the chip it acts on", () => {
  expect(render(row())).toContain('aria-label="Ignore Moonrise"');
  expect(render(row({ ignored: true }))).toContain(
    'aria-label="Unignore Moonrise"',
  );
});

// A chip you would rather not look at is not one you are forbidden to acquire,
// which is the whole difference between this and ignoring the designer.
test("a chip turned away can still be traded for", () => {
  expect(render(row({ ignored: true }))).toContain("Trade for this");
});

test("nothing on the card is pressable while a call is in flight", () => {
  const markup = render(row(), true);

  expect(markup.match(/<button[^>]*disabled/g)?.length).toBe(2);
});

test("a chip already in the collection still says so", () => {
  expect(render(row({ owned: true }))).toContain("owned");
});
