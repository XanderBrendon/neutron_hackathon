import { expect, test } from "bun:test";
import { PIXEL_COUNT, pixelIndexAt, pixelPosition } from "../src/chip.ts";
import { floodRegion } from "../src/flood.ts";

const CENTRE = pixelIndexAt(15, 15)!;

const blank = () => new Uint8Array(PIXEL_COUNT);

/** The chip split down the middle: column 15 painted colour 1. */
const walled = () => {
  const pixels = blank();
  for (let y = 0; y < 31; y += 1) pixels[pixelIndexAt(15, y)!] = 1;
  return pixels;
};

test("a fill on one flat colour covers the whole chip", () => {
  const region = floodRegion(blank(), blank(), CENTRE);

  expect(region).toHaveLength(PIXEL_COUNT);
  expect(new Set(region).size).toBe(PIXEL_COUNT);
  // In index order, so the same fill always describes itself the same way.
  expect(region).toEqual([...region].sort((left, right) => left - right));
});

test("a wall of another colour keeps the two sides apart", () => {
  const pixels = walled();
  const left = floodRegion(pixels, blank(), pixelIndexAt(5, 15)!);
  const right = floodRegion(pixels, blank(), pixelIndexAt(25, 15)!);

  expect(left.every((index) => pixelPosition(index).x < 15)).toBe(true);
  expect(right.every((index) => pixelPosition(index).x > 15)).toBe(true);
  // Every pixel is either on one side or in the wall itself.
  expect(left.length + right.length + 31).toBe(PIXEL_COUNT);

  // The wall is its own region, both halves of it at once.
  expect(floodRegion(pixels, blank(), pixelIndexAt(15, 0)!)).toHaveLength(31);
});

test("locked pixels wall the fill in and never join it", () => {
  const locks = blank();
  for (let y = 0; y < 31; y += 1) locks[pixelIndexAt(15, y)!] = 1;
  const region = floodRegion(blank(), locks, pixelIndexAt(5, 15)!);

  expect(region.length).toBeGreaterThan(0);
  expect(region.every((index) => pixelPosition(index).x < 15)).toBe(true);
  expect(region.some((index) => locks[index] === 1)).toBe(false);

  // Starting on a lock fills nothing at all: the click has no pixel to spread
  // from, so there is no region to show or paint.
  expect(floodRegion(blank(), locks, pixelIndexAt(15, 15)!)).toEqual([]);
});

test("touching at a corner is not touching", () => {
  const pixels = new Uint8Array(PIXEL_COUNT).fill(1);
  pixels[CENTRE] = 0;
  pixels[pixelIndexAt(16, 16)!] = 0;

  expect(floodRegion(pixels, blank(), CENTRE)).toEqual([CENTRE]);
});

test("a fill outside the chip covers nothing", () => {
  expect(floodRegion(blank(), blank(), -1)).toEqual([]);
  expect(floodRegion(blank(), blank(), PIXEL_COUNT)).toEqual([]);
  expect(floodRegion(blank(), blank(), 1.5)).toEqual([]);
});
