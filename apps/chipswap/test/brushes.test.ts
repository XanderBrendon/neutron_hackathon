import { expect, test } from "bun:test";
import { pixelIndexAt } from "../src/chip.ts";
import {
  PRESET_BRUSHES,
  brushCoverage,
  brushFromRecord,
  brushToRecord,
  presetBrush,
  stamp,
} from "../src/brushes.ts";
import { PIXEL_COUNT } from "../src/chip.ts";

const CENTER_X = 15;
const CENTER_Y = 15;

test("the preset library covers the shapes the editor offers", () => {
  const ids = PRESET_BRUSHES.map((brush) => brush.id);
  expect(ids).toEqual(["dot", "square3", "cross", "ex", "fill"]);
  for (const brush of PRESET_BRUSHES) {
    expect(brush.cells.length).toBe(brush.width * brush.height);
    expect(brush.anchorX).toBeLessThan(brush.width);
    expect(brush.anchorY).toBeLessThan(brush.height);
    expect([...brush.cells].every((cell) => cell === 0 || cell === 1)).toBe(true);
  }
});

test("every brush but fill lays down a mask of cells", () => {
  expect(presetBrush("fill").kind).toBe("flood");
  for (const brush of PRESET_BRUSHES) {
    if (brush.id === "fill") continue;
    expect(brush.kind).toBe("mask");
  }
});

test("the fill brush seeds a flood from the pixel under the pointer", () => {
  // A flood brush carries no shape of its own: what it stamps is the one pixel
  // the region grows out of, which flood.ts then spreads.
  expect(stamp(presetBrush("fill"), CENTER_X, CENTER_Y)).toEqual([
    pixelIndexAt(CENTER_X, CENTER_Y)!,
  ]);
  expect(stamp(presetBrush("fill"), 0, 0)).toEqual([]);
});

test("stamping covers exactly the brush cells inside the mask", () => {
  expect(stamp(presetBrush("dot"), CENTER_X, CENTER_Y)).toEqual([
    pixelIndexAt(CENTER_X, CENTER_Y)!,
  ]);
  expect(stamp(presetBrush("square3"), CENTER_X, CENTER_Y)).toHaveLength(9);
  expect(stamp(presetBrush("cross"), CENTER_X, CENTER_Y)).toHaveLength(5);
  expect(stamp(presetBrush("ex"), CENTER_X, CENTER_Y)).toHaveLength(5);
});

test("a stamp never paints outside the chip", () => {
  // Row 0 spans columns 11..19, so a 3x3 brush on its top edge is clipped.
  const top = stamp(presetBrush("square3"), 15, 0);
  expect(top.length).toBeGreaterThan(0);
  expect(top.length).toBeLessThan(9);
  expect(top.every((index) => index >= 0)).toBe(true);

  // Wholly outside the mask, nothing is painted at all.
  expect(stamp(presetBrush("dot"), 0, 0)).toEqual([]);
  expect(stamp(presetBrush("square3"), 30, 30)).toEqual([]);
});

test("the anchor lands on the pointer pixel", () => {
  const pointer = pixelIndexAt(CENTER_X, CENTER_Y)!;
  for (const brush of PRESET_BRUSHES) {
    expect(stamp(brush, CENTER_X, CENTER_Y)).toContain(pointer);
  }
});

test("custom brushes round-trip through the backend record form", () => {
  const brush = presetBrush("cross");
  const record = brushToRecord(brush, "Plus");

  expect(record.name).toBe("Plus");
  expect(record.width).toBe(brush.width);
  expect(record.cells).toBe("000100010101000100");
  expect(record.cells.length).toBe(brush.cells.length * 2);

  const restored = brushFromRecord({ ...record, id: 7 });
  expect(restored.id).toBe("custom-7");
  expect(restored.kind).toBe("mask");
  expect(restored.name).toBe("Plus");
  expect([...restored.cells]).toEqual([...brush.cells]);
  expect(stamp(restored, CENTER_X, CENTER_Y)).toEqual(stamp(brush, CENTER_X, CENTER_Y));
});

test("a malformed brush record is rejected", () => {
  const record = brushToRecord(presetBrush("dot"), "Dot");
  expect(() => brushFromRecord({ ...record, id: 1, cells: "zz" })).toThrow();
  expect(() => brushFromRecord({ ...record, id: 1, width: 4 })).toThrow();
});

const blank = () => new Uint8Array(PIXEL_COUNT);

test("a mask brush covers its own cells, whatever the chip holds", () => {
  const pixels = new Uint8Array(PIXEL_COUNT).fill(1);
  const locks = new Uint8Array(PIXEL_COUNT).fill(1);

  // Neither the color underneath nor the locks change which cells a shape
  // covers: it is the same stamp either way, and the tool sorts out the rest.
  expect(
    brushCoverage(presetBrush("cross"), pixels, locks, CENTER_X, CENTER_Y),
  ).toEqual(stamp(presetBrush("cross"), CENTER_X, CENTER_Y));
});

test("the fill brush covers the region under the pointer", () => {
  const region = brushCoverage(
    presetBrush("fill"),
    blank(),
    blank(),
    CENTER_X,
    CENTER_Y,
  );

  expect(region).toHaveLength(PIXEL_COUNT);
});

test("the fill brush stops at locks unless told to reach through them", () => {
  const locks = new Uint8Array(PIXEL_COUNT).fill(1);
  const fill = presetBrush("fill");

  // Every pixel locked: there is nothing to fill, and nothing to lock either.
  expect(brushCoverage(fill, blank(), locks, CENTER_X, CENTER_Y)).toEqual([]);

  // Reaching through, the same click hands back the whole locked region —
  // which is how unlocking a filled shape gets to be one click.
  expect(
    brushCoverage(fill, blank(), locks, CENTER_X, CENTER_Y, {
      throughLocks: true,
    }),
  ).toHaveLength(PIXEL_COUNT);
});

test("a brush off the edge of the chip covers nothing", () => {
  expect(brushCoverage(presetBrush("fill"), blank(), blank(), 0, 0)).toEqual([]);
  expect(brushCoverage(presetBrush("dot"), blank(), blank(), 0, 0)).toEqual([]);
});
