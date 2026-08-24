// The region a fill would cover: the pixel under the pointer and every pixel
// touching it, edge to edge, that carries the same color. Diagonals do not
// connect, so two blocks meeting at a corner stay two blocks.
//
// Locked pixels are walls rather than holes. Nothing writes to a locked pixel
// anyway, but stopping the spread there is what makes a lock useful to draw
// with: outline a shape, lock the outline, and a fill inside it stays inside.
//
// Unlocking is the exception: a wall the tool exists to take down cannot also
// be what stops it. `throughLocks` drops the lock mask out of the reckoning
// entirely, leaving color as the only thing that bounds the region.

import { PIXEL_COUNT, pixelIndexAt, pixelPosition } from "./chip.ts";

const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export type FloodOptions = {
  /** Spread by color alone, through locked pixels and out of a locked start. */
  throughLocks?: boolean;
};

/** Pixel indices a fill starting at `start` would cover, in index order. */
export function floodRegion(
  pixels: Uint8Array,
  locks: Uint8Array,
  start: number,
  { throughLocks = false }: FloodOptions = {},
): number[] {
  if (!Number.isInteger(start) || start < 0 || start >= PIXEL_COUNT) return [];
  if (!throughLocks && locks[start] === 1) return [];

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
      // examined again from every other neighbor it has.
      seen[next] = 1;
      if (!throughLocks && locks[next] === 1) continue;
      if (pixels[next] !== target) continue;
      queue.push(next);
    }
  }

  return region.sort((left, right) => left - right);
}
