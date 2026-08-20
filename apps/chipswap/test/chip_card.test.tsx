import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PIXEL_COUNT, encodePixels } from "../src/chip.ts";
import { ChipCard } from "../src/chip_card.tsx";
import type { Chip } from "../src/api.ts";

const chip = (overrides: Partial<Chip> = {}): Chip => ({
  key: "held:aaaaa-aa:3:4",
  designer: "aaaaa-aa",
  designId: 3,
  serial: 4,
  title: "Moonrise",
  art: {
    shapeId: "circle31",
    palette: ["#000000", "#7fd1c1"],
    pixels: encodePixels(new Uint8Array(PIXEL_COUNT).fill(1)),
  },
  nsfw: false,
  designRevision: 1,
  mintedAtNs: "1700000000000000000",
  acquiredAtNs: "1700000000000000000",
  state: "held",
  peer: null,
  requestId: null,
  contactName: null,
  origin: "held",
  mintedCount: 0,
  ...overrides,
});

const render = (chip: Chip) =>
  renderToStaticMarkup(
    <ChipCard busy={false} chip={chip} onSave={() => {}} onResolve={() => {}} />,
  );

test("a chip offers both the minimal and the enlarged size", () => {
  const markup = render(chip());
  expect(markup).toContain("Save Moonrise as a 31 by 31 pixel PNG");
  expect(markup).toContain("Save Moonrise as a 496 by 496 pixel PNG");
});

// Two buttons on a card this small have to say which is which without their
// tooltips, because a touch pointer never shows one.
test("the two downloads are told apart on their faces", () => {
  const markup = render(chip());
  expect(markup).toContain(">PNG<");
  expect(markup).toContain(">PNG 16×<");
});

// A chip in escrow is still ours to look at and still ours to keep a picture
// of; only trading it is on hold.
test("a chip committed to a trade can still be saved", () => {
  const markup = render(chip({ state: "escrowed", peer: "bbbbb-bb" }));
  expect(markup).toContain("Save Moonrise as a 31 by 31 pixel PNG");
});

test("our own design can be saved too", () => {
  const markup = render(chip({ origin: "design", mintedCount: 2 }));
  expect(markup).toContain("Save Moonrise as a 31 by 31 pixel PNG");
  expect(markup).toContain("Save Moonrise as a 496 by 496 pixel PNG");
});
