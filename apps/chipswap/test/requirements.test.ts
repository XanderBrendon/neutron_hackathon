import { expect, test } from "bun:test";
import { MAX_PALETTE, PIXEL_COUNT } from "../src/chip.ts";
import {
  MAX_COVERAGE_CEILING,
  check,
  coveragePercent,
  describe,
  failureMessage,
  isOpen,
  isRestrictive,
  measure,
  openRequirements,
  valid,
  type NsfwRule,
  type TradeRequirements,
} from "../src/requirements.ts";

const PALETTE = ["#101010", "#ffffff", "#7fd1c1", "#4f8ad8"];

/** `counts` gives how many pixels each palette index takes, in order. */
function pixelsOf(counts: number[]): Uint8Array {
  const pixels = new Uint8Array(PIXEL_COUNT);
  let at = 0;
  counts.forEach((count, slot) => {
    for (let taken = 0; taken < count && at < PIXEL_COUNT; taken += 1, at += 1) {
      pixels[at] = slot;
    }
  });
  return pixels;
}

function requiring(
  minColors: number | null,
  maxCoverage: number | null,
  nsfw: NsfwRule,
): TradeRequirements {
  return { approval: false, minColors, maxCoverage, nsfw };
}

const PLAIN = measure(pixelsOf([PIXEL_COUNT]), PALETTE);
const MIXED = measure(pixelsOf([400, 300, 57]), PALETTE);

test("colors are counted over the pixels, not over the palette", () => {
  expect(PLAIN.colors).toBe(1);
  expect(PLAIN.topColorPixels).toBe(PIXEL_COUNT);
  expect(PLAIN.totalPixels).toBe(PIXEL_COUNT);

  expect(MIXED.colors).toBe(3);
  expect(MIXED.topColorPixels).toBe(400);

  // A palette entry nothing paints is not a color of this chip, so padding the
  // palette is not a way to satisfy a color minimum.
  const padded = measure(
    pixelsOf([400, 357]),
    Array.from({ length: MAX_PALETTE }, (_, index) => `#0000${index.toString(16).padStart(2, "0")}`),
  );
  expect(padded.colors).toBe(2);

  // Two palette entries holding the same color are one color, and their
  // pixels belong to it together.
  const duplicated = measure(pixelsOf([400, 300, 57]), [
    "#101010",
    "#101010",
    "#7fd1c1",
    "#4f8ad8",
  ]);
  expect(duplicated.colors).toBe(2);
  expect(duplicated.topColorPixels).toBe(700);
});

test("a color minimum is at least, not more than", () => {
  expect(check(requiring(3, null, "any"), MIXED, false)).toBeNull();
  expect(check(requiring(4, null, "any"), MIXED, false)).toBe("min_colors");
});

test("coverage is compared without rounding", () => {
  expect(check(requiring(null, 50, "any"), MIXED, false)).toBe("max_coverage");
  expect(check(requiring(null, 55, "any"), MIXED, false)).toBeNull();

  // 303 of 757 is 40.03%, which a 40% cap refuses even though every sane way of
  // printing it says "40%".
  const justOver = measure(pixelsOf([303, 300, 154]), PALETTE);
  expect(coveragePercent(justOver)).toBe(40);
  expect(check(requiring(null, 40, "any"), justOver, false)).toBe("max_coverage");

  const justUnder = measure(pixelsOf([302, 301, 154]), PALETTE);
  expect(coveragePercent(justUnder)).toBe(40);
  expect(check(requiring(null, 40, "any"), justUnder, false)).toBeNull();
});

test("a tag rule judges the offered chip's own tag", () => {
  expect(check(requiring(null, null, "disallowed"), MIXED, true)).toBe("nsfw_disallowed");
  expect(check(requiring(null, null, "disallowed"), MIXED, false)).toBeNull();
  expect(check(requiring(null, null, "required"), MIXED, false)).toBe("nsfw_required");
  expect(check(requiring(null, null, "required"), MIXED, true)).toBeNull();
  // No rule means the tag is not consulted at all.
  expect(check(requiring(null, null, "any"), MIXED, true)).toBeNull();
});

test("requirements combine, and the first one that fails is the one reported", () => {
  expect(check(requiring(9, 10, "required"), MIXED, false)).toBe("min_colors");
  expect(check(requiring(2, 10, "required"), MIXED, false)).toBe("max_coverage");
  expect(check(requiring(2, 90, "required"), MIXED, false)).toBe("nsfw_required");
  expect(check(requiring(2, 90, "required"), MIXED, true)).toBeNull();

  // A design that asks for nothing accepts anything, including a chip that is
  // entirely one color and tagged.
  expect(check(openRequirements(), PLAIN, true)).toBeNull();
});

test("a requirement that restricts nothing is not a requirement", () => {
  expect(valid(openRequirements())).toBe(true);
  expect(valid(requiring(2, 1, "any"))).toBe(true);
  expect(valid(requiring(MAX_PALETTE, MAX_COVERAGE_CEILING, "required"))).toBe(true);
  expect(valid(requiring(1, null, "any"))).toBe(false);
  expect(valid(requiring(null, 100, "any"))).toBe(false);
  expect(valid(requiring(null, 0, "any"))).toBe(false);
  expect(valid(requiring(MAX_PALETTE + 1, null, "any"))).toBe(false);
  expect(valid(requiring(3.5, null, "any"))).toBe(false);
});

test("approval is neither open nor restrictive", () => {
  expect(isOpen(openRequirements())).toBe(true);
  expect(isRestrictive(openRequirements())).toBe(false);

  // It holds an offer that already qualifies rather than refusing one, so it
  // belongs to neither group the store filters by.
  const approving = { ...openRequirements(), approval: true };
  expect(isOpen(approving)).toBe(false);
  expect(isRestrictive(approving)).toBe(false);

  expect(isRestrictive(requiring(3, null, "any"))).toBe(true);
  expect(isRestrictive(requiring(null, 50, "any"))).toBe(true);
  expect(isRestrictive(requiring(null, null, "disallowed"))).toBe(true);
});

test("a policy reads as a list, most concrete first", () => {
  expect(describe(openRequirements())).toEqual([]);
  expect(describe({ approval: true, minColors: 4, maxCoverage: 60, nsfw: "disallowed" })).toEqual([
    "4 colors or more",
    "no color over 60%",
    "nothing tagged NSFW",
    "designer approves",
  ]);
  expect(describe(requiring(null, null, "required"))).toEqual(["NSFW chips only"]);
});

test("a refusal is phrased about the chip that was offered", () => {
  expect(failureMessage("min_colors")).toBe("uses too few colors");
  expect(failureMessage("max_coverage")).toBe(
    "has one color covering too much of it",
  );
  expect(failureMessage("nsfw_disallowed")).toBe("is tagged NSFW");
  expect(failureMessage("nsfw_required")).toBe("is not tagged NSFW");
});
