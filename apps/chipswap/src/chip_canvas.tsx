// The chip renderer. The base canvas is a real 31x31 image scaled by CSS with
// pixelated smoothing, so a chip is always drawn at exact pixel boundaries. A
// second canvas on top carries the lock hatch, the pixel grid and the brush
// hint, which need sub-cell drawing and must not disturb the artwork
// underneath. A third can sit beneath both, holding a picture being placed for
// a stamp; while it is there the artwork steps back so the picture reads. Both follow the circular mask, so the corners of the square are
// blank rather than looking like cells nobody is allowed to paint. The optional
// centreline accent is the same geometry drawn heavier over the middle row and
// column.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DIAMETER,
  centerEdges,
  maskCells,
  maskEdges,
  outlineEdges,
  pixelIndexAt,
  pixelPosition,
  type MaskEdge,
} from "./chip.ts";
import { parseHexColor } from "./palette.ts";

export type PaintPhase = "start" | "move" | "end";

// Chip geometry never changes, so the overlay walks shared tables.
const MASK_CELLS = maskCells();
const MASK_EDGES = maskEdges();
const CENTER_EDGES = centerEdges();

/** Strokes a run of cell edges as one path, `at` placing a cell boundary. */
const strokeEdges = (
  context: CanvasRenderingContext2D,
  edges: MaskEdge[],
  at: (step: number) => number,
) => {
  context.beginPath();
  for (const { orientation, x, y } of edges) {
    const left = at(x);
    const top = at(y);
    context.moveTo(left, top);
    if (orientation === "vertical") context.lineTo(left, at(y + 1));
    else context.lineTo(at(x + 1), top);
  }
  context.stroke();
};

/** What the pointer is about to do, asked for one hovered cell at a time. */
export type HoverPreview = {
  /** Every chip pixel the brush covers, outlined to show where it sits. */
  cells: number[];
  /** The subset a click would actually change, tinted with `colour`. */
  changes: number[];
  colour: string;
};

/**
 * A picture under the artwork while it is being sited, positioned in chip
 * pixels, so the same numbers place it and sample it.
 */
export type Underlay = {
  source: CanvasImageSource;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ChipCanvasProps = {
  pixels: Uint8Array;
  palette: string[];
  locks?: Uint8Array | undefined;
  scale?: number | undefined;
  showGrid?: boolean | undefined;
  showCenterlines?: boolean | undefined;
  className?: string | undefined;
  label: string;
  onPaint?: ((x: number, y: number, phase: PaintPhase) => void) | undefined;
  hoverPreview?: ((x: number, y: number) => HoverPreview | null) | undefined;
  underlay?: Underlay | null | undefined;
};

export const ChipCanvas = ({
  pixels,
  palette,
  locks,
  scale = 8,
  showGrid = false,
  showCenterlines = false,
  className,
  label,
  onPaint,
  hoverPreview,
  underlay,
}: ChipCanvasProps) => {
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const painting = useRef(false);
  const lastCell = useRef<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const image = context.createImageData(DIAMETER, DIAMETER);
    const colours = palette.map((entry) => {
      try {
        return parseHexColor(entry);
      } catch {
        return { r: 0, g: 0, b: 0 };
      }
    });

    for (let y = 0; y < DIAMETER; y += 1) {
      for (let x = 0; x < DIAMETER; x += 1) {
        const offset = (y * DIAMETER + x) * 4;
        const index = pixelIndexAt(x, y);
        if (index === null) {
          image.data[offset + 3] = 0;
          continue;
        }
        const colour = colours[pixels[index] ?? 0] ?? { r: 0, g: 0, b: 0 };
        image.data[offset] = colour.r;
        image.data[offset + 1] = colour.g;
        image.data[offset + 2] = colour.b;
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [pixels, palette]);

  useEffect(() => {
    const canvas = imageRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!underlay) return;
    // Drawn over the whole square rather than clipped to the chip, so the parts
    // of the picture that would fall off the edge are visible while it is being
    // placed rather than only their absence.
    context.drawImage(
      underlay.source,
      underlay.left * scale,
      underlay.top * scale,
      underlay.width * scale,
      underlay.height * scale,
    );
  }, [scale, underlay]);

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);

    // An odd line width lands crisply when centred half a pixel off the cell
    // boundary; an even one lands crisply on the boundary itself.
    const thin = (step: number) => Math.round(step * scale) + 0.5;
    const thick = (step: number) => Math.round(step * scale);
    const accentWidth = 2 * Math.max(1, Math.round(scale / 12));

    if (showGrid && scale >= 6) {
      // Only the lines that bound a chip pixel, so the corners of the square
      // stay empty and the chip's silhouette comes out of the outermost cells.
      context.strokeStyle = "rgba(242, 245, 247, 0.12)";
      context.lineWidth = 1;
      strokeEdges(context, MASK_EDGES, thin);
    }

    if (showCenterlines && scale >= 6) {
      // Laid over the grid, so the middle row and column read as a band
      // through the chip rather than as another pair of gridlines.
      context.strokeStyle = "rgba(242, 245, 247, 0.5)";
      context.lineWidth = accentWidth;
      strokeEdges(context, CENTER_EDGES, thick);
    }

    // Under the lock hatch on purpose: a hatched cell inside the brush has to
    // go on reading as locked while the hint sits over it.
    const preview = hover && hoverPreview ? hoverPreview(hover.x, hover.y) : null;
    if (preview) {
      context.globalAlpha = 0.6;
      context.fillStyle = preview.colour;
      for (const index of preview.changes) {
        const { x, y } = pixelPosition(index);
        context.fillRect(x * scale, y * scale, scale, scale);
      }
      context.globalAlpha = 1;

      // The whole footprint is outlined, not just the cells that would change,
      // so the brush stays findable where a click would do nothing. The dark
      // pass underneath keeps the line legible over pale artwork.
      const outline = outlineEdges(preview.cells.map((index) => pixelPosition(index)));
      context.strokeStyle = "rgba(14, 20, 26, 0.85)";
      context.lineWidth = 3;
      strokeEdges(context, outline, thin);
      context.strokeStyle = "rgba(242, 245, 247, 0.95)";
      context.lineWidth = 1;
      strokeEdges(context, outline, thin);
    }

    if (!locks) return;
    context.strokeStyle = "rgba(242, 245, 247, 0.75)";
    context.lineWidth = Math.max(1, scale / 8);
    context.beginPath();
    for (const [index, { x, y }] of MASK_CELLS.entries()) {
      if (locks[index] !== 1) continue;
      const left = x * scale;
      const top = y * scale;
      context.moveTo(left + 1, top + scale - 1);
      context.lineTo(left + scale - 1, top + 1);
    }
    context.stroke();
  }, [hover, hoverPreview, locks, scale, showCenterlines, showGrid]);

  const cellFromEvent = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = overlayRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor(((event.clientX - rect.left) / rect.width) * DIAMETER);
      const y = Math.floor(((event.clientY - rect.top) / rect.height) * DIAMETER);
      if (x < 0 || y < 0 || x >= DIAMETER || y >= DIAMETER) return null;
      return { x, y };
    },
    [],
  );

  // Only the cell matters, so a drag across one of them re-renders once.
  const trackHover = (cell: { x: number; y: number } | null) => {
    if (!hoverPreview) return;
    setHover((current) =>
      current?.x === cell?.x && current?.y === cell?.y ? current : cell,
    );
  };

  const handleDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onPaint) return;
    const cell = cellFromEvent(event);
    trackHover(cell);
    if (!cell) return;
    painting.current = true;
    lastCell.current = `${cell.x}:${cell.y}`;
    event.currentTarget.setPointerCapture(event.pointerId);
    onPaint(cell.x, cell.y, "start");
  };

  const handleMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const cell = cellFromEvent(event);
    trackHover(cell);
    if (!onPaint || !painting.current) return;
    if (!cell) return;
    const key = `${cell.x}:${cell.y}`;
    // A drag across one cell fires once, so a stroke is one history entry per
    // cell rather than one per pointer sample.
    if (key === lastCell.current) return;
    lastCell.current = key;
    onPaint(cell.x, cell.y, "move");
  };

  // A touch pointer stops existing on lift, so the hint goes with it.
  const handleLeave = () => trackHover(null);

  const handleUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onPaint || !painting.current) return;
    painting.current = false;
    lastCell.current = null;
    const cell = cellFromEvent(event);
    onPaint(cell?.x ?? -1, cell?.y ?? -1, "end");
  };

  const size = DIAMETER * scale;

  return (
    <div
      className={className ? `chipswap-canvas ${className}` : "chipswap-canvas"}
      style={{ width: `${size}px`, height: `${size}px` }}
    >
      {underlay ? (
        <canvas
          className="chipswap-canvas-image"
          height={size}
          ref={imageRef}
          width={size}
        />
      ) : null}
      <canvas
        aria-label={label}
        className={
          underlay
            ? "chipswap-canvas-base chipswap-canvas-base--ghost"
            : "chipswap-canvas-base"
        }
        height={DIAMETER}
        ref={baseRef}
        role="img"
        width={DIAMETER}
      />
      <canvas
        className="chipswap-canvas-overlay"
        height={size}
        onPointerCancel={handleUp}
        onPointerDown={handleDown}
        onPointerLeave={handleLeave}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        ref={overlayRef}
        style={{
          cursor: !onPaint ? "default" : underlay ? "grab" : "crosshair",
        }}
        width={size}
      />
    </div>
  );
};
