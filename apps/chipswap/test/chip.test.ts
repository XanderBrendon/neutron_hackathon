import { expect, test } from "bun:test";
import {
  CENTER,
  DIAMETER,
  PIXEL_COUNT,
  ROW_OFFSETS,
  ROW_WIDTHS,
  SHAPE_ID,
  decodePixels,
  encodePixels,
  centerEdges,
  maskCells,
  maskEdges,
  maskRowWidths,
  outlineEdges,
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

test("the centre accent frames the middle row and column", () => {
  const edges = centerEdges();
  const keys = edges.map(({ orientation, x, y }) => `${orientation}:${x}:${y}`);

  expect(CENTER).toBe(15);
  expect(new Set(keys).size).toBe(keys.length);

  // Two lines above and below the middle row, two either side of the middle
  // column: the row and column that meet at the centre pixel are boxed in.
  const expected = new Set<string>();
  for (let x = 0; x < DIAMETER; x += 1) {
    expected.add(`horizontal:${x}:${CENTER}`);
    expected.add(`horizontal:${x}:${CENTER + 1}`);
  }
  for (let y = 0; y < DIAMETER; y += 1) {
    expected.add(`vertical:${CENTER}:${y}`);
    expected.add(`vertical:${CENTER + 1}:${y}`);
  }
  expect(new Set(keys)).toEqual(expected);

  // The accent is drawn over the grid, so it may only thicken lines the grid
  // already has: none of it reaches into the bare corners.
  const grid = new Set(
    maskEdges().map(({ orientation, x, y }) => `${orientation}:${x}:${y}`),
  );
  for (const key of keys) expect(grid.has(key)).toBe(true);
});

test("an outline traces a cell set's boundary and nothing inside it", () => {
  expect(outlineEdges([{ x: 4, y: 4 }])).toEqual([
    { orientation: "vertical", x: 4, y: 4 },
    { orientation: "vertical", x: 5, y: 4 },
    { orientation: "horizontal", x: 4, y: 4 },
    { orientation: "horizontal", x: 4, y: 5 },
  ]);

  const block: { x: number; y: number }[] = [];
  for (let y = 2; y < 5; y += 1) {
    for (let x = 2; x < 5; x += 1) block.push({ x, y });
  }
  const keys = outlineEdges(block).map(
    ({ orientation, x, y }) => `${orientation}:${x}:${y}`,
  );

  // Three edges along each of the four sides, and nothing between neighbours:
  // a brush stamp reads as one shape rather than as a box per cell.
  expect(new Set(keys).size).toBe(keys.length);
  expect(keys).toHaveLength(12);
  expect(keys).toContain("vertical:2:3");
  expect(keys).toContain("vertical:5:3");
  expect(keys).not.toContain("vertical:3:3");
  expect(keys).not.toContain("horizontal:3:3");

  // Stamps hand over their cells as indices, so a repeat is possible and must
  // not stroke the same edge twice.
  expect(outlineEdges([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toHaveLength(4);
  expect(outlineEdges([])).toEqual([]);
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
