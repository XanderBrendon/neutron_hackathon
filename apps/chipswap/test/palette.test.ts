import { expect, test } from "bun:test";
import {
  MAX_PALETTE,
  blendColors,
  formatHexColor,
  isHexColor,
  parseHexColor,
} from "../src/palette.ts";

test("hex colors parse and format symmetrically", () => {
  expect(parseHexColor("#7fd1c1")).toEqual({ r: 0x7f, g: 0xd1, b: 0xc1 });
  expect(formatHexColor({ r: 0x7f, g: 0xd1, b: 0xc1 })).toBe("#7fd1c1");
  expect(formatHexColor({ r: 0, g: 0, b: 0 })).toBe("#000000");
  expect(formatHexColor(parseHexColor("#000000"))).toBe("#000000");
});

test("malformed colors are rejected, never guessed", () => {
  expect(() => parseHexColor("#gg0000")).toThrow();
  expect(() => parseHexColor("7fd1c1")).toThrow();
  expect(() => parseHexColor("#7fd1c")).toThrow();
  expect(() => parseHexColor("#7FD1C1")).toThrow();
  expect(isHexColor("#7fd1c1")).toBe(true);
  expect(isHexColor("#7FD1C1")).toBe(false);
  expect(isHexColor("rebeccapurple")).toBe(false);
});

test("blending walks the straight line between two colors", () => {
  expect(blendColors("#000000", "#ffffff", 0.5)).toBe("#808080");
  expect(blendColors("#ff0000", "#0000ff", 0)).toBe("#ff0000");
  expect(blendColors("#ff0000", "#0000ff", 1)).toBe("#0000ff");
  expect(blendColors("#ff0000", "#0000ff", 0.5)).toBe("#800080");
  // Out-of-range ratios clamp rather than producing an impossible color.
  expect(blendColors("#ff0000", "#0000ff", -1)).toBe("#ff0000");
  expect(blendColors("#ff0000", "#0000ff", 2)).toBe("#0000ff");
});

test("the palette limit matches the backend", () => {
  expect(MAX_PALETTE).toBe(64);
});
