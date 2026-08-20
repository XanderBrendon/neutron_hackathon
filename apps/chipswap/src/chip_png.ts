// Rendering a chip as a PNG. A chip is a 31px raster circle, so the smallest
// honest picture of one is a 31x31 PNG: every chip pixel is one image pixel and
// nothing is invented. The scaled version is that same image blown up with
// smoothing off, so it stays the same picture rather than becoming a blurred
// approximation of it. The corners of the square are not chip pixels at all,
// and they come out transparent in both.
//
// Nothing here downloads. The app runs in an iframe sandboxed with
// `allow-scripts` and no `allow-downloads`, and Chrome refuses a download
// started in such a frame whether script clicks the anchor or a person does.
// The PNG reaches somebody by being shown to them; see chip_save_panel.tsx.

import { DIAMETER, pixelIndexAt } from "./chip.ts";
import { parseHexColor, type Rgb } from "./palette.ts";

const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/**
 * The chip as a 31x31 RGBA raster, transparent outside the mask. A color the
 * palette cannot supply reads as black rather than throwing: art that outlived
 * its palette still has to draw, on screen and on the way to a file alike.
 */
export function chipRgba(
  pixels: Uint8Array,
  palette: string[],
): Uint8ClampedArray<ArrayBuffer> {
  const colors = palette.map((entry) => {
    try {
      return parseHexColor(entry);
    } catch {
      return BLACK;
    }
  });

  const data = new Uint8ClampedArray(DIAMETER * DIAMETER * 4);
  for (let y = 0; y < DIAMETER; y += 1) {
    for (let x = 0; x < DIAMETER; x += 1) {
      const offset = (y * DIAMETER + x) * 4;
      const index = pixelIndexAt(x, y);
      if (index === null) continue;
      const color = colors[pixels[index] ?? 0] ?? BLACK;
      data[offset] = color.r;
      data[offset + 1] = color.g;
      data[offset + 2] = color.b;
      data[offset + 3] = 255;
    }
  }
  return data;
}

/** The title as one lowercase hyphenated run, or nothing if it had no words. */
function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * What the file is called once it lands: the title, the serial that tells two
 * copies of one design apart, and the size, so downloading both sizes of one
 * chip does not have the second arrive as "(1)".
 */
export function chipFileName(
  title: string,
  serial: number | null,
  scale: number,
): string {
  const parts = [slug(title) || "chip"];
  if (serial !== null) parts.push(String(serial));
  parts.push(`${DIAMETER * scale}px`);
  return `${parts.join("-")}.png`;
}

/** The two sizes offered: the chip itself, and one big enough to look at. */
export const MINIMAL_SCALE = 1;
export const ENLARGED_SCALE = 16;

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser has no 2D canvas to draw with.");
  return context;
}

/** The chip at its own size, one image pixel per chip pixel. */
function drawChip(pixels: Uint8Array, palette: string[]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = DIAMETER;
  canvas.height = DIAMETER;
  const data = chipRgba(pixels, palette);
  context2d(canvas).putImageData(new ImageData(data, DIAMETER, DIAMETER), 0, 0);
  return canvas;
}

/**
 * The same picture at `scale` image pixels per chip pixel. Smoothing off is the
 * whole point: interpolation would soften every edge in the artwork and feather
 * the transparent surround into a grey halo around the chip.
 */
function enlarge(base: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = DIAMETER * scale;
  canvas.height = DIAMETER * scale;
  const context = context2d(canvas);
  context.imageSmoothingEnabled = false;
  context.drawImage(base, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * The chip as a PNG data URL, transparent outside the circle at either size.
 *
 * A data URL rather than an object URL: the app frame cannot start a download,
 * so the PNG's only route to a person is being shown as an image they save
 * through the browser's own menu, and an image that stays on screen must not
 * depend on a URL somebody has to remember to revoke.
 */
export function chipPngDataUrl(
  pixels: Uint8Array,
  palette: string[],
  scale: number,
): string {
  const base = drawChip(pixels, palette);
  const canvas = scale === MINIMAL_SCALE ? base : enlarge(base, scale);
  return canvas.toDataURL("image/png");
}
