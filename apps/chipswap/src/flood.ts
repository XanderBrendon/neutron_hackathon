// The region a fill would cover: the pixel under the pointer and every pixel
// touching it, edge to edge, that carries the same colour. Diagonals do not
// connect, so two blocks meeting at a corner stay two blocks.
//
// Locked pixels are walls rather than holes. Nothing writes to a locked pixel
// anyway, but stopping the spread there is what makes a lock useful to draw
// with: outline a shape, lock the outline, and a fill inside it stays inside.

import { PIXEL_COUNT, pixelIndexAt, pixelPosition } from "./chip.ts";

const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Pixel indices a fill starting at `start` would cover, in index order. */
export function floodRegion(
  pixels: Uint8Array,
  locks: Uint8Array,
  start: number,
): number[] {
  if (!Number.isInteger(start) || start < 0 || start >= PIXEL_COUNT) return [];
  if (locks[start] === 1) return [];

  const target = pixels[start];
  const seen = new Uint8Array(PIXEL_COUNT);
  const region: number[] = [];
  const queue = [start];
  seen[start] = 1;

  while (queue.length > 0) {
    const index = queue.pop()!;
    region.push(index);
    const { x, y } = pixelPosition(index);
    for (const [dx, dy] of STEPS) {
      const next = pixelIndexAt(x + dx, y + dy);
      if (next === null || seen[next] === 1) continue;
      // Marked on the way in, so a pixel the fill turns away from is not
      // examined again from every other neighbour it has.
      seen[next] = 1;
      if (locks[next] === 1 || pixels[next] !== target) continue;
      queue.push(next);
    }
  }

  return region.sort((left, right) => left - right);
}
