import { expect, test } from "bun:test";
import { pixelIndexAt } from "../src/chip.ts";
import {
  PRESET_BRUSHES,
  brushFromRecord,
  brushToRecord,
  presetBrush,
  stamp,
} from "../src/brushes.ts";

const CENTER_X = 15;
const CENTER_Y = 15;

test("the preset library covers the shapes the editor offers", () => {
  const ids = PRESET_BRUSHES.map((brush) => brush.id);
  expect(ids).toEqual(["dot", "square2", "square3", "cross", "ex"]);
  for (const brush of PRESET_BRUSHES) {
    expect(brush.cells.length).toBe(brush.width * brush.height);
    expect(brush.anchorX).toBeLessThan(brush.width);
    expect(brush.anchorY).toBeLessThan(brush.height);
    expect([...brush.cells].every((cell) => cell === 0 || cell === 1)).toBe(true);
  }
});

test("stamping covers exactly the brush cells inside the mask", () => {
  expect(stamp(presetBrush("dot"), CENTER_X, CENTER_Y)).toEqual([
    pixelIndexAt(CENTER_X, CENTER_Y)!,
  ]);
  expect(stamp(presetBrush("square3"), CENTER_X, CENTER_Y)).toHaveLength(9);
  expect(stamp(presetBrush("square2"), CENTER_X, CENTER_Y)).toHaveLength(4);
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
  expect(restored.name).toBe("Plus");
  expect([...restored.cells]).toEqual([...brush.cells]);
  expect(stamp(restored, CENTER_X, CENTER_Y)).toEqual(stamp(brush, CENTER_X, CENTER_Y));
});

test("a malformed brush record is rejected", () => {
  const record = brushToRecord(presetBrush("dot"), "Dot");
  expect(() => brushFromRecord({ ...record, id: 1, cells: "zz" })).toThrow();
  expect(() => brushFromRecord({ ...record, id: 1, width: 4 })).toThrow();
});
