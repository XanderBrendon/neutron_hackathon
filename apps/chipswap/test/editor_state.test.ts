import { expect, test } from "bun:test";
import { PIXEL_COUNT, pixelIndexAt } from "../src/chip.ts";
import {
  addPaletteColor,
  endStroke,
  applyPattern,
  canRemovePaletteColor,
  createEditorState,
  lockAllOfColor,
  paint,
  paintLocks,
  patternShowing,
  previewPattern,
  redo,
  removePaletteColor,
  undo,
  unlockAll,
} from "../src/editor_state.ts";

const PALETTE = ["#000000", "#ffffff", "#7fd1c1"];

function fresh() {
  return createEditorState({
    palette: PALETTE,
    pixels: new Uint8Array(PIXEL_COUNT),
  });
}

const A = pixelIndexAt(15, 15)!;
const B = pixelIndexAt(16, 15)!;
const C = pixelIndexAt(17, 15)!;

test("a new state carries the art and no locks", () => {
  const state = fresh();
  expect(state.palette).toEqual(PALETTE);
  expect(state.pixels.length).toBe(PIXEL_COUNT);
  expect([...state.locks].every((lock) => lock === 0)).toBe(true);
  expect(state.canUndo).toBe(false);
  expect(state.canRedo).toBe(false);
});

test("painting writes only the given pixels and never mutates in place", () => {
  const state = fresh();
  const painted = paint(state, [A, B], 2);

  expect(painted.pixels[A]).toBe(2);
  expect(painted.pixels[B]).toBe(2);
  expect(painted.pixels[C]).toBe(0);
  expect(state.pixels[A]).toBe(0);
  expect(painted.canUndo).toBe(true);
});

test("painting a colour that is not in the palette is refused", () => {
  const state = fresh();
  expect(() => paint(state, [A], 9)).toThrow();
});

test("locked pixels survive every mutation", () => {
  let state = paint(fresh(), [A], 1);
  state = paintLocks(state, [A], true);

  expect(state.locks[A]).toBe(1);
  expect(paint(state, [A, B], 2).pixels[A]).toBe(1);
  expect(paint(state, [A, B], 2).pixels[B]).toBe(2);

  const generated = new Uint8Array(PIXEL_COUNT).fill(2);
  const filled = applyPattern(state, { pixels: generated, palette: PALETTE });
  expect(filled.pixels[A]).toBe(1);
  expect(filled.pixels[B]).toBe(2);
});

test("locking by colour selects exactly that colour's pixels", () => {
  let state = paint(fresh(), [A, B], 1);
  state = paint(state, [C], 2);
  state = lockAllOfColor(state, 1);

  expect(state.locks[A]).toBe(1);
  expect(state.locks[B]).toBe(1);
  expect(state.locks[C]).toBe(0);

  const unlocked = unlockAll(state);
  expect([...unlocked.locks].every((lock) => lock === 0)).toBe(true);
});

test("unlocking by brush clears only the given pixels", () => {
  let state = paintLocks(fresh(), [A, B], true);
  state = paintLocks(state, [A], false);

  expect(state.locks[A]).toBe(0);
  expect(state.locks[B]).toBe(1);
});

test("undo and redo walk the paint history", () => {
  let state = fresh();
  state = paint(state, [A], 1);
  state = paint(state, [B], 1);
  state = paint(state, [C], 2);

  expect(state.pixels[C]).toBe(2);

  const undone = undo(state);
  expect(undone.pixels[C]).toBe(0);
  expect(undone.pixels[B]).toBe(1);
  expect(undone.canRedo).toBe(true);

  const redone = redo(undone);
  expect(redone.pixels[C]).toBe(2);
  expect(redone.canRedo).toBe(false);

  // Undoing past the beginning is a no-op, not a crash.
  let rewound = undo(undo(undo(undo(state))));
  expect([...rewound.pixels].every((pixel) => pixel === 0)).toBe(true);
  expect(rewound.canUndo).toBe(false);
  rewound = undo(rewound);
  expect([...rewound.pixels].every((pixel) => pixel === 0)).toBe(true);

  // Painting after an undo drops the redo branch.
  const branched = paint(undo(state), [A], 2);
  expect(branched.canRedo).toBe(false);
});

test("a drag undoes as one stroke", () => {
  let state = fresh();
  state = paint(state, [A], 1, "begin");
  state = paint(state, [B], 1, "extend");
  state = paint(state, [C], 1, "extend");
  state = endStroke(state);

  expect(state.pixels[A]).toBe(1);
  expect(state.pixels[C]).toBe(1);

  // One undo clears the whole stroke, not just its last pixel.
  const undone = undo(state);
  expect([...undone.pixels].every((pixel) => pixel === 0)).toBe(true);
  expect(undone.canUndo).toBe(false);

  // A second drag is a separate entry.
  let second = paint(state, [A], 2, "begin");
  second = endStroke(second);
  expect(undo(second).pixels[A]).toBe(1);
});

test("locks are part of the undo history", () => {
  const state = paintLocks(fresh(), [A], true);
  expect(undo(state).locks[A]).toBe(0);
});

test("a no-op paint does not grow the history", () => {
  const state = paint(fresh(), [A], 0);
  expect(state.canUndo).toBe(false);
});

test("palette colours can be added up to the limit", () => {
  let state = addPaletteColor(fresh(), "#123456");
  expect(state.palette).toHaveLength(4);
  expect(state.palette[3]).toBe("#123456");

  // Adding a colour already present selects it instead of duplicating it.
  state = addPaletteColor(state, "#123456");
  expect(state.palette).toHaveLength(4);
  expect(state.activeColor).toBe(3);

  expect(() => addPaletteColor(state, "not a colour")).toThrow();
});

test("a palette colour is removable only while unused", () => {
  const painted = paint(fresh(), [A], 2);

  expect(canRemovePaletteColor(painted, 2)).toBe(false);
  expect(removePaletteColor(painted, 2).palette).toHaveLength(3);

  const unused = fresh();
  expect(canRemovePaletteColor(unused, 2)).toBe(true);
  const removed = removePaletteColor(unused, 2);
  expect(removed.palette).toEqual(["#000000", "#ffffff"]);

  // The last colour can never go: a chip needs somewhere to point.
  let single = removePaletteColor(removed, 1);
  single = removePaletteColor(single, 0);
  expect(single.palette).toHaveLength(1);
});

test("removing a colour renumbers the pixels above it", () => {
  let state = fresh();
  state = addPaletteColor(state, "#123456");
  state = paint(state, [A], 3);
  state = paint(state, [B], 1);

  // Colour 2 is unused, so removing it shifts colour 3 down to 2.
  expect(canRemovePaletteColor(state, 2)).toBe(true);
  const removed = removePaletteColor(state, 2);
  expect(removed.palette).toEqual(["#000000", "#ffffff", "#123456"]);
  expect(removed.pixels[A]).toBe(2);
  expect(removed.pixels[B]).toBe(1);
});

test("a pattern preview shows the locked pixels as they will stay", () => {
  let state = paint(fresh(), [A], 1);
  state = paintLocks(state, [A], true);
  const generated = new Uint8Array(PIXEL_COUNT).fill(2);

  // What the preview draws is what applying it produces, pixel for pixel.
  const shown = previewPattern(state, { pixels: generated, palette: PALETTE });
  expect(shown[A]).toBe(1);
  expect(shown[B]).toBe(2);
  expect([...shown]).toEqual([
    ...applyPattern(state, { pixels: generated, palette: PALETTE }).pixels,
  ]);
});

test("a pattern may bring colours of its own", () => {
  const state = fresh();
  const pixels = new Uint8Array(PIXEL_COUNT).fill(3);
  const stamped = applyPattern(state, {
    pixels,
    palette: [...PALETTE, "#112233"],
  });

  expect(stamped.palette).toEqual([...PALETTE, "#112233"]);
  expect(stamped.pixels[A]).toBe(3);
  expect(undo(stamped).palette).toEqual(PALETTE);
});

test("a pattern that renames the chip's colours is refused", () => {
  const state = fresh();
  const pixels = new Uint8Array(PIXEL_COUNT);

  // Dropping or reordering an existing colour would repaint the pixels the
  // pattern is not allowed to touch.
  expect(() =>
    applyPattern(state, { pixels, palette: ["#ffffff", "#000000", "#7fd1c1"] }),
  ).toThrow();
  expect(() => applyPattern(state, { pixels, palette: ["#000000"] })).toThrow();
  expect(() =>
    applyPattern(state, {
      pixels: new Uint8Array(PIXEL_COUNT).fill(9),
      palette: PALETTE,
    }),
  ).toThrow();
});

test("a pattern that changes nothing does not grow the history", () => {
  const state = fresh();
  const pixels = new Uint8Array(PIXEL_COUNT);
  expect(applyPattern(state, { pixels, palette: PALETTE }).canUndo).toBe(false);
});

test("a chip recognises the art a pattern left on it", () => {
  let state = paint(fresh(), [A], 1);
  state = paintLocks(state, [A], true);
  const pattern = {
    pixels: new Uint8Array(PIXEL_COUNT).fill(3),
    palette: [...PALETTE, "#112233"],
  };
  const stamped = applyPattern(state, pattern);

  // The art on the chip, not the pattern as offered: the locked pixel kept its
  // own colour, so the pattern itself no longer describes what is there.
  const art = { pixels: stamped.pixels, palette: stamped.palette };
  expect(patternShowing(stamped, art)).toBe(true);
  expect(patternShowing(stamped, pattern)).toBe(false);

  // Stepping off that art is how an undo is known to have undone this stamp,
  // and stepping back on to it is how a redo is known to have redone it.
  expect(patternShowing(undo(stamped), art)).toBe(false);
  expect(patternShowing(redo(undo(stamped)), art)).toBe(true);

  // A palette that has moved on is a different chip, whatever the pixels say.
  expect(patternShowing(addPaletteColor(stamped, "#654321"), art)).toBe(false);
  expect(patternShowing(paint(stamped, [B], 0), art)).toBe(false);
});
