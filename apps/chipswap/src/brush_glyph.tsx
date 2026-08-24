// A brush drawn as itself. Every brush is placed on the same 7x7 field rather
// than scaled to fill the button, because the size of the mark is half of what
// a brush is: a one-pixel brush has to read as a speck next to a 3x3 slab. The
// cells it leaves alone stay faintly visible, so the shape has a frame to sit
// in and a cross reads as a cross rather than as a plus of unknown size.
//
// A flood brush has no cells to draw — its single cell is a seed, and drawing
// that would make it the 1px brush over again. It gets a mark of its own on
// the same field: a seed cell with the spread running out of it.

import { MAX_BRUSH_SIDE, type Brush } from "./brushes.ts";

// Cells are inset inside their square so neighbors stay separate marks.
const INSET = 0.1;

/** The seed, then the cells it has run into, reading outward from the middle. */
const FLOOD_SPREAD = [
  [3, 3],
  [2, 3],
  [4, 3],
  [3, 2],
  [3, 4],
  [1, 3],
  [5, 3],
  [2, 2],
  [4, 2],
  [2, 4],
  [4, 4],
] as const;

const FloodGlyph = () => (
  <svg
    aria-hidden="true"
    className="chipswap-brush-glyph"
    viewBox={`0 0 ${MAX_BRUSH_SIDE} ${MAX_BRUSH_SIDE}`}
  >
    {FLOOD_SPREAD.map(([x, y], step) => (
      <rect
        height={1 - INSET * 2}
        key={`${x}-${y}`}
        // The seed is solid and the spread fades as it gets further out, so
        // the mark reads as running from somewhere rather than as a blob.
        opacity={step === 0 ? 1 : 0.75 - step * 0.05}
        width={1 - INSET * 2}
        x={x + INSET}
        y={y + INSET}
      />
    ))}
  </svg>
);

export const BrushGlyph = ({ brush }: { brush: Brush }) => {
  if (brush.kind === "flood") return <FloodGlyph />;

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
