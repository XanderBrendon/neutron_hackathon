// A brush drawn as itself. Every brush is placed on the same 7x7 field rather
// than scaled to fill the button, because the size of the mark is half of what
// a brush is: a one-pixel brush has to read as a speck next to a 3x3 slab. The
// cells it leaves alone stay faintly visible, so the shape has a frame to sit
// in and a cross reads as a cross rather than as a plus of unknown size.

import { MAX_BRUSH_SIDE, type Brush } from "./brushes.ts";

// Cells are inset inside their square so neighbors stay separate marks.
const INSET = 0.1;

export const BrushGlyph = ({ brush }: { brush: Brush }) => {
  const offsetX = (MAX_BRUSH_SIDE - brush.width) / 2;
  const offsetY = (MAX_BRUSH_SIDE - brush.height) / 2;

  return (
    <svg
      aria-hidden="true"
      className="chipswap-brush-glyph"
      viewBox={`0 0 ${MAX_BRUSH_SIDE} ${MAX_BRUSH_SIDE}`}
    >
      {[...brush.cells].map((cell, offset) => (
        <rect
          height={1 - INSET * 2}
          key={offset}
          opacity={cell === 1 ? 1 : 0.16}
          width={1 - INSET * 2}
          x={offsetX + (offset % brush.width) + INSET}
          y={offsetY + Math.floor(offset / brush.width) + INSET}
        />
      ))}
    </svg>
  );
};
