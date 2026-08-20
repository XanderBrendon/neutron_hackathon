// Stamping an image onto a chip. A chip is 31 pixels across, so nearly all of a
// photograph has to go: what survives is one color per chip pixel, averaged
// from every image pixel that lands inside it, and a palette small enough to
// store. The image's own colors are reduced to a budget the caller sets, which
// is what lets a stamp land in a chip that already has colors of its own.
//
// Nothing here touches the DOM. The caller decodes the image and hands over a
// plain raster, which is what keeps the sampling and the color reduction
// testable outside a browser.

import { DIAMETER, PIXEL_COUNT, pixelPosition } from "./chip.ts";
import {
  MAX_PALETTE,
  formatHexColor,
  parseHexColor,
  type Rgb,
} from "./palette.ts";

/** Decoded image data, the shape `getImageData` hands back. */
export type Raster = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

/** Where the image sits over the chip grid, measured in chip pixels. */
export type Placement = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** What a stamp needs to know about the chip it is landing on. */
export type StampTarget = {
  palette: string[];
  pixels: Uint8Array;
  locks: Uint8Array;
};

export type Stamp = {
  pixels: Uint8Array;
  palette: string[];
  /** How many colors the stamp brought into the palette. */
  added: number;
};

const EMPTY_PLACEMENT: Placement = { left: 0, top: 0, width: 0, height: 0 };

// Anything this transparent counts as absent rather than as black, so a logo on
// a transparent background leaves the chip showing through instead of sooting
// it: averaging in an unpainted pixel would drag the color toward nothing.
const MIN_ALPHA = 128;

const CHANNELS = ["r", "g", "b"] as const;

type Channel = (typeof CHANNELS)[number];

/**
 * The image scaled to cover the whole chip, centered, then zoomed and nudged.
 * Cover rather than contain: at zoom 1 the chip is full, and zooming out is how
 * you ask for margins.
 */
export function coverPlacement(
  raster: { width: number; height: number },
  zoom: number,
  offsetX: number,
  offsetY: number,
): Placement {
  if (raster.width < 1 || raster.height < 1 || zoom <= 0) return EMPTY_PLACEMENT;
  const fit = Math.max(DIAMETER / raster.width, DIAMETER / raster.height) * zoom;
  const width = raster.width * fit;
  const height = raster.height * fit;
  return {
    left: (DIAMETER - width) / 2 + offsetX,
    top: (DIAMETER - height) / 2 + offsetY,
    width,
    height,
  };
}

/** First image row or column whose center falls at or after `edge`. */
const firstCovered = (edge: number) => Math.max(0, Math.ceil(edge - 0.5));

/** Last one whose center falls before `edge`, clamped to the raster. */
const lastCovered = (edge: number, limit: number) =>
  Math.min(limit - 1, Math.ceil(edge - 0.5) - 1);

function averageRegion(
  raster: Raster,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): Rgb | null {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  const toX = lastCovered(x1, raster.width);
  const toY = lastCovered(y1, raster.height);
  for (let y = firstCovered(y0); y <= toY; y += 1) {
    for (let x = firstCovered(x0); x <= toX; x += 1) {
      const offset = (y * raster.width + x) * 4;
      if (raster.data[offset + 3]! < MIN_ALPHA) continue;
      red += raster.data[offset]!;
      green += raster.data[offset + 1]!;
      blue += raster.data[offset + 2]!;
      count += 1;
    }
  }
  if (count > 0) return { r: red / count, g: green / count, b: blue / count };

  // Zoomed in far enough, a chip pixel sits inside a single image pixel and
  // contains no pixel center at all. It takes the color under its own center
  // rather than nothing, so magnifying a picture keeps stamping it.
  const x = Math.floor((x0 + x1) / 2);
  const y = Math.floor((y0 + y1) / 2);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return null;
  const offset = (y * raster.width + x) * 4;
  if (raster.data[offset + 3]! < MIN_ALPHA) return null;
  return {
    r: raster.data[offset]!,
    g: raster.data[offset + 1]!,
    b: raster.data[offset + 2]!,
  };
}

/**
 * One average color per chip pixel, or null where the image does not reach —
 * off the edge of the picture, or over a transparent part of it. A null pixel
 * is not a color to choose, it is a pixel the stamp leaves alone.
 */
export function sampleChip(
  raster: Raster,
  placement: Placement,
): (Rgb | null)[] {
  const samples: (Rgb | null)[] = new Array(PIXEL_COUNT).fill(null);
  if (raster.width < 1 || raster.height < 1) return samples;
  if (placement.width <= 0 || placement.height <= 0) return samples;

  // Image pixels per chip pixel, along each axis.
  const perCellX = raster.width / placement.width;
  const perCellY = raster.height / placement.height;
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    const { x, y } = pixelPosition(index);
    samples[index] = averageRegion(
      raster,
      (x - placement.left) * perCellX,
      (x + 1 - placement.left) * perCellX,
      (y - placement.top) * perCellY,
      (y + 1 - placement.top) * perCellY,
    );
  }
  return samples;
}

function spread(box: Rgb[], channel: Channel): number {
  let low = Infinity;
  let high = -Infinity;
  for (const color of box) {
    if (color[channel] < low) low = color[channel];
    if (color[channel] > high) high = color[channel];
  }
  return high - low;
}

function average(box: Rgb[]): Rgb {
  let red = 0;
  let green = 0;
  let blue = 0;
  for (const color of box) {
    red += color.r;
    green += color.g;
    blue += color.b;
  }
  return { r: red / box.length, g: green / box.length, b: blue / box.length };
}

/**
 * Median cut: the colors are held in one box, which is split at its median
 * along its widest channel until there are `max` boxes, and each box collapses
 * to its average. It keeps a color that only a corner of the picture depends
 * on, which picking the commonest colors does not.
 */
export function quantize(colors: Rgb[], max: number): Rgb[] {
  if (max < 1 || colors.length === 0) return [];
  let boxes: Rgb[][] = [colors];
  while (boxes.length < max) {
    let target = -1;
    let widest = 0;
    let along: Channel = "r";
    for (const [index, box] of boxes.entries()) {
      if (box.length < 2) continue;
      for (const channel of CHANNELS) {
        const width = spread(box, channel);
        if (width <= widest) continue;
        widest = width;
        target = index;
        along = channel;
      }
    }
    // Every box left holds one color, or many copies of one: nothing to split.
    if (target < 0) break;
    const sorted = [...boxes[target]!].sort((left, right) => left[along] - right[along]);
    const middle = Math.floor(sorted.length / 2);
    boxes = [
      ...boxes.slice(0, target),
      sorted.slice(0, middle),
      sorted.slice(middle),
      ...boxes.slice(target + 1),
    ];
  }

  // Two boxes can average to the same color, and a palette has no use for the
  // same color twice.
  const seen = new Set<string>();
  const reduced: Rgb[] = [];
  for (const box of boxes) {
    const color = average(box);
    const hex = formatHexColor(color);
    if (seen.has(hex)) continue;
    seen.add(hex);
    reduced.push(color);
  }
  return reduced;
}

/**
 * Nearest palette color by weighted distance. The weights are the usual cheap
 * stand-in for how the eye reads the channels: green counts most, blue least.
 */
function nearestIndex(palette: Rgb[], color: Rgb): number {
  let best = 0;
  let closest = Infinity;
  for (const [index, entry] of palette.entries()) {
    const dr = entry.r - color.r;
    const dg = entry.g - color.g;
    const db = entry.b - color.b;
    const distance = dr * dr * 2 + dg * dg * 4 + db * db * 3;
    if (distance >= closest) continue;
    closest = distance;
    best = index;
  }
  return best;
}

/**
 * The chip an image would leave behind. `budget` is how many of the image's own
 * colors may join the palette; at zero the picture is approximated with the
 * colors the chip already has.
 *
 * Locked pixels are left out of both halves of the work: they keep their
 * color, and their samples take no part in the reduction, so the whole budget
 * is spent on the pixels the stamp can actually reach.
 */
export function buildStamp(
  raster: Raster,
  placement: Placement,
  chip: StampTarget,
  budget: number,
): Stamp {
  const samples = sampleChip(raster, placement);
  const writable: number[] = [];
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    if (samples[index] && chip.locks[index] !== 1) writable.push(index);
  }

  const palette = [...chip.palette];
  const room = Math.max(0, MAX_PALETTE - palette.length);
  const wanted = quantize(
    writable.map((index) => samples[index]!),
    Math.min(budget, room),
  );
  for (const color of wanted) {
    const hex = formatHexColor(color);
    if (!palette.includes(hex)) palette.push(hex);
  }

  const colors = palette.map(parseHexColor);
  const pixels = Uint8Array.from(chip.pixels);
  for (const index of writable) {
    pixels[index] = nearestIndex(colors, samples[index]!);
  }
  return { pixels, palette, added: palette.length - chip.palette.length };
}
