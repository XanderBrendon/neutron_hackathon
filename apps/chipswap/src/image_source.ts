// Getting a picture out of a file or a clipboard and into a raster the stamp
// can sample. The decoded image is redrawn once into a small working copy: a
// chip is 31 pixels across, so nothing is gained by dragging ten megapixels
// through every step of the placement, and everything is gained by keeping the
// resample fast enough to preview live.

import type { Raster } from "./image_stamp.ts";

/** Longest side of the working copy. Well past what 31 pixels can show. */
const WORKING_SIDE = 512;

export type LoadedImage = {
  raster: Raster;
  /** The same pixels as a canvas, for drawing the picture under the chip. */
  source: HTMLCanvasElement;
  /** The size it arrived at, which is what the person recognises. */
  width: number;
  height: number;
};

export async function loadImage(blob: Blob): Promise<LoadedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error("That file is not an image this browser can read.");
  }
  try {
    // Never upscaled: a small picture is already smaller than the working copy,
    // and stretching it here would only invent detail for the sampler to average
    // back out.
    const shrink = Math.min(1, WORKING_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * shrink));
    const height = Math.max(1, Math.round(bitmap.height * shrink));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser has no 2D canvas to decode with.");
    context.drawImage(bitmap, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    return {
      raster: { width, height, data },
      source: canvas,
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

/** The first image on a paste, or null when the clipboard carried none. */
export function clipboardImage(data: DataTransfer | null): File | null {
  for (const item of data?.items ?? []) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}
