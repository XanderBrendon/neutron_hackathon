// Editor state and its reducers. Every reducer is pure: it copies the typed
// arrays it changes and returns a new state, so React re-renders predictably and
// undo can hold real snapshots.
//
// One rule runs through all of it: a locked pixel is never written, by any
// action, including a pattern generator or a stamped image.

import { PIXEL_COUNT } from "./chip.ts";
import { MAX_PALETTE, isHexColor } from "./palette.ts";

const MAX_HISTORY = 60;

type Snapshot = {
  pixels: Uint8Array;
  locks: Uint8Array;
  palette: string[];
};

export type EditorState = Snapshot & {
  activeColor: number;
  past: Snapshot[];
  future: Snapshot[];
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  /** True while a drag is in progress, so the whole stroke undoes as one step. */
  strokeOpen: boolean;
};

export type EditorSeed = {
  palette: string[];
  pixels: Uint8Array;
};

function snapshot(state: Snapshot): Snapshot {
  return {
    pixels: Uint8Array.from(state.pixels),
    locks: Uint8Array.from(state.locks),
    palette: [...state.palette],
  };
}

function withHistory(
  state: EditorState,
  next: Snapshot,
  stroke: "none" | "begin" | "extend" = "none",
): EditorState {
  // Extending an open stroke updates the artwork without adding a second undo
  // entry, so dragging across forty pixels is one edit rather than forty.
  const past =
    stroke === "extend" && state.strokeOpen
      ? state.past
      : [...state.past, snapshot(state)].slice(-MAX_HISTORY);
  return {
    ...state,
    ...next,
    past,
    // A new edit abandons the redo branch, as every editor does.
    future: [],
    canUndo: past.length > 0,
    canRedo: false,
    dirty: true,
    strokeOpen: stroke !== "none",
    activeColor: Math.min(state.activeColor, next.palette.length - 1),
  };
}

export function createEditorState(seed: EditorSeed): EditorState {
  if (seed.palette.length === 0) throw new Error("A chip needs a palette");
  if (seed.pixels.length !== PIXEL_COUNT) {
    throw new Error(`A chip has exactly ${PIXEL_COUNT} pixels`);
  }
  return {
    palette: [...seed.palette],
    pixels: Uint8Array.from(seed.pixels),
    locks: new Uint8Array(PIXEL_COUNT),
    activeColor: 0,
    past: [],
    future: [],
    canUndo: false,
    canRedo: false,
    dirty: false,
    strokeOpen: false,
  };
}

export function selectColor(state: EditorState, index: number): EditorState {
  if (index < 0 || index >= state.palette.length) return state;
  return { ...state, activeColor: index };
}

export function paint(
  state: EditorState,
  indices: number[],
  colorIndex: number,
  stroke: "none" | "begin" | "extend" = "none",
): EditorState {
  if (colorIndex < 0 || colorIndex >= state.palette.length) {
    throw new Error(`Colour ${colorIndex} is not in the palette`);
  }
  const pixels = Uint8Array.from(state.pixels);
  let changed = false;
  for (const index of indices) {
    if (index < 0 || index >= PIXEL_COUNT) continue;
    if (state.locks[index] === 1) continue;
    if (pixels[index] === colorIndex) continue;
    pixels[index] = colorIndex;
    changed = true;
  }
  if (!changed) return state;
  return withHistory(
    state,
    { pixels, locks: state.locks, palette: state.palette },
    stroke,
  );
}

export function paintLocks(
  state: EditorState,
  indices: number[],
  locked: boolean,
  stroke: "none" | "begin" | "extend" = "none",
): EditorState {
  const locks = Uint8Array.from(state.locks);
  const value = locked ? 1 : 0;
  let changed = false;
  for (const index of indices) {
    if (index < 0 || index >= PIXEL_COUNT) continue;
    if (locks[index] === value) continue;
    locks[index] = value;
    changed = true;
  }
  if (!changed) return state;
  return withHistory(
    state,
    { pixels: state.pixels, locks, palette: state.palette },
    stroke,
  );
}

/** Ends the current drag so the next edit starts a fresh undo entry. */
export function endStroke(state: EditorState): EditorState {
  return state.strokeOpen ? { ...state, strokeOpen: false } : state;
}

export function lockAllOfColor(state: EditorState, colorIndex: number): EditorState {
  const indices: number[] = [];
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    if (state.pixels[index] === colorIndex) indices.push(index);
  }
  return paintLocks(state, indices, true);
}

export function unlockAll(state: EditorState): EditorState {
  if (![...state.locks].some((lock) => lock === 1)) return state;
  return withHistory(state, {
    pixels: state.pixels,
    locks: new Uint8Array(PIXEL_COUNT),
    palette: state.palette,
  });
}

export function lockAll(state: EditorState): EditorState {
  const locks = new Uint8Array(PIXEL_COUNT).fill(1);
  return withHistory(state, { pixels: state.pixels, locks, palette: state.palette });
}

/**
 * A whole chip proposed at once: a generated pattern, or an image stamped over
 * the artwork. A pattern may bring colours of its own, which is how a
 * photograph lands on a chip that has never seen those colours.
 */
export type Pattern = {
  pixels: Uint8Array;
  /** The palette its pixels index into: the chip's, possibly extended. */
  palette: string[];
};

function checkPattern(state: EditorState, pattern: Pattern): void {
  if (pattern.pixels.length !== PIXEL_COUNT) {
    throw new Error(`A pattern has exactly ${PIXEL_COUNT} pixels`);
  }
  if (pattern.palette.length > MAX_PALETTE) {
    throw new Error(`A palette holds at most ${MAX_PALETTE} colours`);
  }
  if (!pattern.palette.every(isHexColor)) {
    throw new Error("A pattern palette must be lowercase #rrggbb colours");
  }
  // The palette may grow, but the colours already on the chip have to keep
  // their index: a locked pixel is never written to, so if its colour moved it
  // would change anyway, without anything having touched it.
  if (state.palette.some((colour, index) => pattern.palette[index] !== colour)) {
    throw new Error("A pattern palette must extend the chip's own palette");
  }
  for (const value of pattern.pixels) {
    if (value >= pattern.palette.length) {
      throw new Error("A pattern pixel refers to a colour outside the palette");
    }
  }
}

/**
 * Whether a pattern still lines up with this chip. A preview held open across
 * an edit can go stale — removing a palette colour renumbers the pixels — and
 * a stale preview is dropped rather than drawn against the wrong colours.
 */
export function patternFits(state: EditorState, pattern: Pattern): boolean {
  return (
    pattern.pixels.length === PIXEL_COUNT &&
    pattern.palette.length <= MAX_PALETTE &&
    state.palette.every((colour, index) => pattern.palette[index] === colour)
  );
}

/**
 * The chip as the pattern would leave it, so a preview shows what applying it
 * really does: locked pixels keep the colour they have.
 */
export function previewPattern(state: EditorState, pattern: Pattern): Uint8Array {
  checkPattern(state, pattern);
  const pixels = Uint8Array.from(pattern.pixels);
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    if (state.locks[index] === 1) pixels[index] = state.pixels[index]!;
  }
  return pixels;
}

/** Commits a pattern, leaving every locked pixel untouched. */
export function applyPattern(state: EditorState, pattern: Pattern): EditorState {
  const pixels = previewPattern(state, pattern);
  const grew = pattern.palette.length > state.palette.length;
  if (!grew && pixels.every((value, index) => value === state.pixels[index])) {
    return state;
  }
  return withHistory(state, {
    pixels,
    locks: state.locks,
    palette: [...pattern.palette],
  });
}

export function addPaletteColor(state: EditorState, color: string): EditorState {
  if (!isHexColor(color)) {
    throw new Error(`Expected a lowercase #rrggbb colour, received "${color}"`);
  }
  const existing = state.palette.indexOf(color);
  if (existing >= 0) return { ...state, activeColor: existing };
  if (state.palette.length >= MAX_PALETTE) return state;
  const palette = [...state.palette, color];
  const next = withHistory(state, {
    pixels: state.pixels,
    locks: state.locks,
    palette,
  });
  return { ...next, activeColor: palette.length - 1 };
}

export function canRemovePaletteColor(state: EditorState, index: number): boolean {
  if (index < 0 || index >= state.palette.length) return false;
  if (state.palette.length <= 1) return false;
  return ![...state.pixels].some((pixel) => pixel === index);
}

/**
 * Removes an unused colour and renumbers the pixels above it. A colour still on
 * the chip is kept: dropping it would silently repaint the artwork.
 */
export function removePaletteColor(state: EditorState, index: number): EditorState {
  if (!canRemovePaletteColor(state, index)) return state;
  const palette = state.palette.filter((_, position) => position !== index);
  const pixels = Uint8Array.from(state.pixels);
  for (let position = 0; position < PIXEL_COUNT; position += 1) {
    if (pixels[position]! > index) pixels[position] = pixels[position]! - 1;
  }
  const next = withHistory(state, { pixels, locks: state.locks, palette });
  return { ...next, activeColor: Math.min(next.activeColor, palette.length - 1) };
}

export function undo(state: EditorState): EditorState {
  const previous = state.past.at(-1);
  if (!previous) return state;
  const past = state.past.slice(0, -1);
  const future = [snapshot(state), ...state.future].slice(0, MAX_HISTORY);
  return {
    ...state,
    ...previous,
    past,
    future,
    canUndo: past.length > 0,
    canRedo: true,
    dirty: true,
    strokeOpen: false,
    activeColor: Math.min(state.activeColor, previous.palette.length - 1),
  };
}

export function redo(state: EditorState): EditorState {
  const [next, ...rest] = state.future;
  if (!next) return state;
  const past = [...state.past, snapshot(state)].slice(-MAX_HISTORY);
  return {
    ...state,
    ...next,
    past,
    future: rest,
    canUndo: true,
    canRedo: rest.length > 0,
    dirty: true,
    strokeOpen: false,
    activeColor: Math.min(state.activeColor, next.palette.length - 1),
  };
}

export function markSaved(state: EditorState): EditorState {
  return { ...state, dirty: false };
}
