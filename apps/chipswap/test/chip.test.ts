import { expect, test } from "bun:test";
import {
  DIAMETER,
  PIXEL_COUNT,
  ROW_OFFSETS,
  ROW_WIDTHS,
  SHAPE_ID,
  decodePixels,
  encodePixels,
  maskCells,
  maskEdges,
  maskRowWidths,
  pixelIndexAt,
  pixelPosition,
  rowOffsets,
} from "../src/chip.ts";

test("the documented row table is exactly a 31px raster circle", () => {
  expect(ROW_WIDTHS.length).toBe(31);
  expect(SHAPE_ID).toBe("circle31");
  expect(DIAMETER).toBe(31);
  expect([...ROW_WIDTHS]).toEqual(maskRowWidths(31, 0.04));
  expect(ROW_WIDTHS.reduce((total, width) => total + width, 0)).toBe(
    PIXEL_COUNT,
  );
  expect(PIXEL_COUNT).toBe(757);
});

test("row offsets are the running sum and match the Motoko table", () => {
  const offsets = rowOffsets();
  expect(offsets).toEqual([...ROW_OFFSETS]);
  expect(offsets[0]).toBe(0);
  expect(offsets[1]).toBe(9);
  expect(offsets[2]).toBe(22);
  expect(offsets[15]).toBe(363);
  expect(offsets[30]).toBe(748);

  let running = 0;
  for (const [row, width] of ROW_WIDTHS.entries()) {
    expect(offsets[row]).toBe(running);
    running += width;
  }
  expect(running).toBe(PIXEL_COUNT);
});

test("pixel lookup respects the circular mask", () => {
  expect(pixelIndexAt(11, 0)).toBe(0);
  expect(pixelIndexAt(19, 0)).toBe(8);
  expect(pixelIndexAt(10, 0)).toBeNull();
  expect(pixelIndexAt(20, 0)).toBeNull();
  expect(pixelIndexAt(0, 15)).toBe(363);
  expect(pixelIndexAt(31, 15)).toBeNull();
  expect(pixelIndexAt(-1, 4)).toBeNull();
  expect(pixelIndexAt(4, -1)).toBeNull();
  expect(pixelIndexAt(1.5, 4)).toBeNull();
});

test("pixel positions invert the lookup for every index", () => {
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    const { x, y } = pixelPosition(index);
    expect(pixelIndexAt(x, y)).toBe(index);
  }
  expect(() => pixelPosition(PIXEL_COUNT)).toThrow();
  expect(() => pixelPosition(-1)).toThrow();
});

test("mask cells are the chip's pixels and nothing else", () => {
  const cells = maskCells();

  expect(cells).toHaveLength(PIXEL_COUNT);
  cells.forEach((cell, index) => {
    expect(pixelIndexAt(cell.x, cell.y)).toBe(index);
  });

  // The four corners of the 31x31 square lie outside the chip, so the grid
  // drawn from these cells leaves them blank.
  const occupied = new Set(cells.map(({ x, y }) => `${x}:${y}`));
  expect(occupied.has("0:0")).toBe(false);
  expect(occupied.has("30:0")).toBe(false);
  expect(occupied.has("0:30")).toBe(false);
  expect(occupied.has("30:30")).toBe(false);
  expect(occupied.has("15:0")).toBe(true);
  expect(occupied.has("0:15")).toBe(true);
});

test("the mask's edges are listed once each", () => {
  const edges = maskEdges();

  // A translucent line stroked twice reads as a brighter line, so every shared
  // edge between two cells must appear exactly once.
  const keys = edges.map(({ orientation, x, y }) => `${orientation}:${x}:${y}`);
  expect(new Set(keys).size).toBe(keys.length);

  // Every edge borders the chip on at least one side, and every cell is fully
  // enclosed by four of them.
  for (const { orientation, x, y } of edges) {
    const before =
      orientation === "vertical" ? pixelIndexAt(x - 1, y) : pixelIndexAt(x, y - 1);
    expect(before !== null || pixelIndexAt(x, y) !== null).toBe(true);
  }
  const drawn = new Set(keys);
  for (const { x, y } of maskCells()) {
    expect(drawn.has(`vertical:${x}:${y}`)).toBe(true);
    expect(drawn.has(`vertical:${x + 1}:${y}`)).toBe(true);
    expect(drawn.has(`horizontal:${x}:${y}`)).toBe(true);
    expect(drawn.has(`horizontal:${x}:${y + 1}`)).toBe(true);
  }

  // Nothing is drawn out in the corners of the square.
  expect(drawn.has("vertical:0:0")).toBe(false);
  expect(drawn.has("horizontal:0:0")).toBe(false);
  expect(drawn.has("vertical:31:30")).toBe(false);
});

test("pixels round-trip through lowercase hex", () => {
  const pixels = new Uint8Array(PIXEL_COUNT).fill(7);
  pixels[3] = 255;
  const hex = encodePixels(pixels);

  expect(hex).toHaveLength(PIXEL_COUNT * 2);
  expect(hex).toBe(hex.toLowerCase());
  expect(decodePixels(hex)).toEqual(pixels);
});

test("pixel decoding rejects malformed input", () => {
  const valid = encodePixels(new Uint8Array(PIXEL_COUNT).fill(0xab));

  expect(() => decodePixels(valid.slice(0, -2))).toThrow();
  expect(() => decodePixels(valid + "00")).toThrow();
  expect(() => decodePixels(valid.slice(0, -1))).toThrow();
  expect(() => decodePixels("zz".repeat(PIXEL_COUNT))).toThrow();
  expect(() => decodePixels(valid.toUpperCase())).toThrow();
});

test("encoding rejects a wrong pixel count", () => {
  expect(() => encodePixels(new Uint8Array(756))).toThrow();
});
