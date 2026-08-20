// Brushes are a cell mask plus an anchor. Stamping maps the mask onto chip
// coordinates and keeps only the cells that land inside the circular mask, so a
// brush near the edge paints less rather than spilling into the next row.

import { decodeHex, encodeHex, pixelIndexAt } from "./chip.ts";

export const MAX_BRUSH_CELLS = 49;
export const MAX_BRUSH_SIDE = 7;

export type Brush = {
  id: string;
  name: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  cells: Uint8Array;
};

export type BrushRecord = {
  name: string;
  width: number;
  height: number;
  anchor_x: number;
  anchor_y: number;
  cells: string;
};

function brush(
  id: string,
  name: string,
  width: number,
  height: number,
  anchorX: number,
  anchorY: number,
  cells: number[],
): Brush {
  return {
    id,
    name,
    width,
    height,
    anchorX,
    anchorY,
    cells: Uint8Array.from(cells),
  };
}

export const PRESET_BRUSHES: readonly Brush[] = [
  brush("dot", "1 px", 1, 1, 0, 0, [1]),
  brush("square2", "2 × 2", 2, 2, 0, 0, [1, 1, 1, 1]),
  brush("square3", "3 × 3", 3, 3, 1, 1, [1, 1, 1, 1, 1, 1, 1, 1, 1]),
  brush("cross", "Cross", 3, 3, 1, 1, [0, 1, 0, 1, 1, 1, 0, 1, 0]),
  brush("ex", "X", 3, 3, 1, 1, [1, 0, 1, 0, 1, 0, 1, 0, 1]),
];

export function presetBrush(id: string): Brush {
  const found = PRESET_BRUSHES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Unknown preset brush: ${id}`);
  return found;
}

/** Chip pixel indices this brush covers when its anchor sits on (x, y). */
export function stamp(brush: Brush, x: number, y: number): number[] {
  const indices: number[] = [];
  for (let row = 0; row < brush.height; row += 1) {
    for (let column = 0; column < brush.width; column += 1) {
      if (brush.cells[row * brush.width + column] !== 1) continue;
      const index = pixelIndexAt(
        x + column - brush.anchorX,
        y + row - brush.anchorY,
      );
      if (index !== null) indices.push(index);
    }
  }
  return indices;
}

export function brushToRecord(brush: Brush, name: string): BrushRecord {
  return {
    name,
    width: brush.width,
    height: brush.height,
    anchor_x: brush.anchorX,
    anchor_y: brush.anchorY,
    cells: encodeHex(brush.cells),
  };
}

export function brushFromRecord(record: BrushRecord & { id: number }): Brush {
  const { width, height, anchor_x: anchorX, anchor_y: anchorY } = record;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_BRUSH_SIDE ||
    height > MAX_BRUSH_SIDE
  ) {
    throw new Error("Brush dimensions are out of range");
  }
  if (anchorX >= width || anchorY >= height || anchorX < 0 || anchorY < 0) {
    throw new Error("Brush anchor is outside the brush");
  }
  const cells = decodeHex(record.cells);
  if (cells.length !== width * height) {
    throw new Error("Brush cell count does not match its dimensions");
  }
  if (![...cells].every((cell) => cell === 0 || cell === 1)) {
    throw new Error("Brush cells must be 0 or 1");
  }
  return {
    id: `custom-${record.id}`,
    name: record.name,
    width,
    height,
    anchorX,
    anchorY,
    cells,
  };
}

/** An empty editable grid for the custom brush editor. */
export function blankBrush(side = 5): Brush {
  const anchor = Math.floor(side / 2);
  return {
    id: "draft",
    name: "",
    width: side,
    height: side,
    anchorX: anchor,
    anchorY: anchor,
    cells: new Uint8Array(side * side),
  };
}

export function toggleBrushCell(brush: Brush, column: number, row: number): Brush {
  const cells = Uint8Array.from(brush.cells);
  const offset = row * brush.width + column;
  cells[offset] = cells[offset] === 1 ? 0 : 1;
  return { ...brush, cells };
}

export function brushIsEmpty(brush: Brush): boolean {
  return ![...brush.cells].some((cell) => cell === 1);
}
