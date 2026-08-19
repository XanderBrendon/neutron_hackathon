// The chip renderer. The base canvas is a real 31x31 image scaled by CSS with
// pixelated smoothing, so a chip is always drawn at exact pixel boundaries. A
// second canvas on top carries the lock hatch and the pixel grid, which need
// sub-cell drawing and must not disturb the artwork underneath.

import { useCallback, useEffect, useRef } from "react";
import { DIAMETER, pixelIndexAt } from "./chip.ts";
import { parseHexColor } from "./palette.ts";

export type PaintPhase = "start" | "move" | "end";

export type ChipCanvasProps = {
  pixels: Uint8Array;
  palette: string[];
  locks?: Uint8Array | undefined;
  scale?: number | undefined;
  showGrid?: boolean | undefined;
  className?: string | undefined;
  label: string;
  onPaint?: ((x: number, y: number, phase: PaintPhase) => void) | undefined;
};

export const ChipCanvas = ({
  pixels,
  palette,
  locks,
  scale = 8,
  showGrid = false,
  className,
  label,
  onPaint,
}: ChipCanvasProps) => {
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const painting = useRef(false);
  const lastCell = useRef<string | null>(null);

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
    const canvas = overlayRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);

    if (showGrid && scale >= 6) {
      context.strokeStyle = "rgba(242, 245, 247, 0.12)";
      context.lineWidth = 1;
      context.beginPath();
      for (let step = 0; step <= DIAMETER; step += 1) {
        const position = Math.round(step * scale) + 0.5;
        context.moveTo(position, 0);
        context.lineTo(position, canvas.height);
        context.moveTo(0, position);
        context.lineTo(canvas.width, position);
      }
      context.stroke();
    }

    if (!locks) return;
    context.strokeStyle = "rgba(242, 245, 247, 0.75)";
    context.lineWidth = Math.max(1, scale / 8);
    context.beginPath();
    for (let y = 0; y < DIAMETER; y += 1) {
      for (let x = 0; x < DIAMETER; x += 1) {
        const index = pixelIndexAt(x, y);
        if (index === null || locks[index] !== 1) continue;
        const left = x * scale;
        const top = y * scale;
        context.moveTo(left + 1, top + scale - 1);
        context.lineTo(left + scale - 1, top + 1);
      }
    }
    context.stroke();
  }, [locks, scale, showGrid]);

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

  const handleDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onPaint) return;
    const cell = cellFromEvent(event);
    if (!cell) return;
    painting.current = true;
    lastCell.current = `${cell.x}:${cell.y}`;
    event.currentTarget.setPointerCapture(event.pointerId);
    onPaint(cell.x, cell.y, "start");
  };

  const handleMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onPaint || !painting.current) return;
    const cell = cellFromEvent(event);
    if (!cell) return;
    const key = `${cell.x}:${cell.y}`;
    // A drag across one cell fires once, so a stroke is one history entry per
    // cell rather than one per pointer sample.
    if (key === lastCell.current) return;
    lastCell.current = key;
    onPaint(cell.x, cell.y, "move");
  };

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
      <canvas
        aria-label={label}
        className="chipswap-canvas-base"
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
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        ref={overlayRef}
        style={{ cursor: onPaint ? "crosshair" : "default" }}
        width={size}
      />
    </div>
  );
};
