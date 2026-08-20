// Chip geometry, mirrored from backend/Shape.mo. The row table in
// Planning/chipswap.md is the source of truth; maskRowWidths() only proves that
// the table really is a 31px raster circle. Keep both files in step: the shared
// tests assert the offsets agree.

export const SHAPE_ID = "circle31";
export const DIAMETER = 31;
/** Row and column of the middle pixel: the chip is an odd number wide. */
export const CENTER = (DIAMETER - 1) / 2;
export const MAX_PALETTE = 64;

export const ROW_WIDTHS: readonly number[] = [
  9, 13, 17, 19, 21, 23, 25, 27, 27, 29, 29, 31, 31, 31, 31, 31, 31, 31, 31,
  31, 29, 29, 27, 27, 25, 23, 21, 19, 17, 13, 9,
] as const;

export const PIXEL_COUNT = 757;

function computeRowOffsets(): number[] {
  const offsets: number[] = [];
  let running = 0;
  for (const width of ROW_WIDTHS) {
    offsets.push(running);
    running += width;
  }
  return offsets;
}

export const ROW_OFFSETS: readonly number[] = computeRowOffsets();

export function rowOffsets(): number[] {
  return [...ROW_OFFSETS];
}

/** Row start column for chip-local coordinates: each row is centred. */
export function rowStart(row: number): number {
  return (DIAMETER - ROW_WIDTHS[row]!) / 2;
}

/** Rasterise a circle the way Planning/circle-bench_1.html does, for the check. */
export function maskRowWidths(diameter: number, eps: number): number[] {
  const centre = diameter / 2;
  const radius = diameter / 2 + eps;
  const squared = radius * radius;
  const widths: number[] = [];
  for (let y = 0; y < diameter; y += 1) {
    const dy = y + 0.5 - centre;
    let count = 0;
    for (let x = 0; x < diameter; x += 1) {
      const dx = x + 0.5 - centre;
      if (dx * dx + dy * dy <= squared) count += 1;
    }
    widths.push(count);
  }
  return widths;
}

/** Pixel index for chip-local coordinates, or null outside the mask. */
export function pixelIndexAt(x: number, y: number): number | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (y < 0 || y >= ROW_WIDTHS.length) return null;
  if (x < 0 || x >= DIAMETER) return null;
  const width = ROW_WIDTHS[y]!;
  const start = (DIAMETER - width) / 2;
  if (x < start || x >= start + width) return null;
  return ROW_OFFSETS[y]! + (x - start);
}

/**
 * Chip-local coordinates of every pixel, in index order. Renderers walk this
 * instead of the 31x31 square so the corners outside the circle stay blank.
 */
export function maskCells(): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < ROW_WIDTHS.length; y += 1) {
    const start = rowStart(y);
    for (let column = 0; column < ROW_WIDTHS[y]!; column += 1) {
      cells.push({ x: start + column, y });
    }
  }
  return cells;
}

/** A cell edge: vertical runs from (x, y) to (x, y + 1), horizontal to (x + 1, y). */
export type MaskEdge = {
  orientation: "vertical" | "horizontal";
  x: number;
  y: number;
};

/**
 * Every grid line bounding the chip, listed once each. Stroking a rectangle per
 * cell would be simpler, but it draws each shared edge twice, and a translucent
 * line composited twice reads as a brighter line.
 */
export function maskEdges(): MaskEdge[] {
  const edges: MaskEdge[] = [];
  for (const { x, y } of maskCells()) {
    // The left and top edges belong to this cell; the right and bottom ones
    // belong to the neighbour, unless there is no neighbour to draw them.
    edges.push({ orientation: "vertical", x, y });
    edges.push({ orientation: "horizontal", x, y });
    if (pixelIndexAt(x + 1, y) === null) {
      edges.push({ orientation: "vertical", x: x + 1, y });
    }
    if (pixelIndexAt(x, y + 1) === null) {
      edges.push({ orientation: "horizontal", x, y: y + 1 });
    }
  }
  return edges;
}

/** The lines boxing in the middle row and the middle column, once each. */
export function centerEdges(): MaskEdge[] {
  const edges: MaskEdge[] = [];
  for (const { x, y } of maskCells()) {
    if (y === CENTER) {
      edges.push({ orientation: "horizontal", x, y });
      edges.push({ orientation: "horizontal", x, y: y + 1 });
    }
    if (x === CENTER) {
      edges.push({ orientation: "vertical", x, y });
      edges.push({ orientation: "vertical", x: x + 1, y });
    }
  }
  return edges;
}

/**
 * The boundary of an arbitrary set of cells: every edge with a cell on exactly
 * one side of it. A brush stamp traced this way comes out as one line around
 * the whole footprint rather than a box drawn around each cell.
 */
export function outlineEdges(cells: { x: number; y: number }[]): MaskEdge[] {
  const inside = new Map(cells.map((cell) => [`${cell.x}:${cell.y}`, cell]));
  const edges: MaskEdge[] = [];
  for (const { x, y } of inside.values()) {
    if (!inside.has(`${x - 1}:${y}`)) {
      edges.push({ orientation: "vertical", x, y });
    }
    if (!inside.has(`${x + 1}:${y}`)) {
      edges.push({ orientation: "vertical", x: x + 1, y });
    }
    if (!inside.has(`${x}:${y - 1}`)) {
      edges.push({ orientation: "horizontal", x, y });
    }
    if (!inside.has(`${x}:${y + 1}`)) {
      edges.push({ orientation: "horizontal", x, y: y + 1 });
    }
  }
  return edges;
}

/** Inverse of pixelIndexAt. */
export function pixelPosition(index: number): { x: number; y: number } {
  if (!Number.isInteger(index) || index < 0 || index >= PIXEL_COUNT) {
    throw new Error(`Pixel index out of range: ${index}`);
  }
  let row = 0;
  while (row + 1 < ROW_OFFSETS.length && ROW_OFFSETS[row + 1]! <= index) {
    row += 1;
  }
  const width = ROW_WIDTHS[row]!;
  const start = (DIAMETER - width) / 2;
  return { x: start + (index - ROW_OFFSETS[row]!), y: row };
}

const HEX_DIGITS = "0123456789abcdef";

export function encodePixels(pixels: Uint8Array): string {
  if (pixels.length !== PIXEL_COUNT) {
    throw new Error(`Expected ${PIXEL_COUNT} pixels, received ${pixels.length}`);
  }
  let out = "";
  for (const value of pixels) {
    out += HEX_DIGITS[(value >> 4) & 0xf]! + HEX_DIGITS[value & 0xf]!;
  }
  return out;
}

export function decodePixels(hex: string): Uint8Array {
  if (hex.length !== PIXEL_COUNT * 2) {
    throw new Error(`Expected ${PIXEL_COUNT * 2} hex characters`);
  }
  const pixels = new Uint8Array(PIXEL_COUNT);
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    const high = HEX_DIGITS.indexOf(hex[index * 2]!);
    const low = HEX_DIGITS.indexOf(hex[index * 2 + 1]!);
    if (high < 0 || low < 0) {
      throw new Error("Pixel data is not lowercase hexadecimal");
    }
    pixels[index] = (high << 4) | low;
  }
  return pixels;
}

/** Bytes as lowercase hex, used for custom brush cells and request ids. */
export function encodeHex(bytes: Uint8Array): string {
  let out = "";
  for (const value of bytes) {
    out += HEX_DIGITS[(value >> 4) & 0xf]! + HEX_DIGITS[value & 0xf]!;
  }
  return out;
}

export function decodeHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Hex length must be even");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const high = HEX_DIGITS.indexOf(hex[index * 2]!);
    const low = HEX_DIGITS.indexOf(hex[index * 2 + 1]!);
    if (high < 0 || low < 0) throw new Error("Value is not lowercase hexadecimal");
    bytes[index] = (high << 4) | low;
  }
  return bytes;
}
