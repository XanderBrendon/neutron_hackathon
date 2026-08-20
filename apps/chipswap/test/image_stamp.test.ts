import { expect, test } from "bun:test";
import { DIAMETER, PIXEL_COUNT, pixelIndexAt } from "../src/chip.ts";
import { MAX_PALETTE, formatHexColor } from "../src/palette.ts";
import {
  buildStamp,
  coverPlacement,
  quantise,
  sampleChip,
  type Raster,
} from "../src/image_stamp.ts";

/** A raster painted by a function, so each test says what its image looks like. */
function raster(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number],
): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = paint(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return { width, height, data };
}

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const CLEAR: [number, number, number, number] = [0, 0, 0, 0];

// 62 is two image pixels per chip pixel, and 30 is a boundary between chip
// pixels, so a split there falls on a chip pixel edge rather than through one.
const SPLIT = 30;

const blankChip = (palette: string[]) => ({
  palette,
  pixels: new Uint8Array(PIXEL_COUNT),
  locks: new Uint8Array(PIXEL_COUNT),
});

test("a placement covers the chip and stays centred", () => {
  const square = coverPlacement({ width: 100, height: 100 }, 1, 0, 0);
  expect(square).toEqual({ left: 0, top: 0, width: DIAMETER, height: DIAMETER });

  // A wide picture covers the chip on both axes: the short side decides.
  const wide = coverPlacement({ width: 64, height: 32 }, 1, 0, 0);
  expect(wide.height).toBeCloseTo(DIAMETER);
  expect(wide.width).toBeCloseTo(62);
  expect(wide.left).toBeCloseTo((DIAMETER - 62) / 2);

  const zoomed = coverPlacement({ width: 100, height: 100 }, 2, 0, 0);
  expect(zoomed.width).toBeCloseTo(DIAMETER * 2);
  // Zooming holds the centre, so the picture grows around the middle pixel.
  expect(zoomed.left + zoomed.width / 2).toBeCloseTo(DIAMETER / 2);

  const nudged = coverPlacement({ width: 100, height: 100 }, 1, 3, -2);
  expect(nudged.left).toBe(3);
  expect(nudged.top).toBe(-2);

  expect(coverPlacement({ width: 0, height: 0 }, 1, 0, 0).width).toBe(0);
});

test("a chip pixel takes the average of the image pixels inside it", () => {
  // Every chip pixel covers two black and two white image pixels.
  const checker = raster(62, 62, (x, y) =>
    (x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255],
  );
  const samples = sampleChip(checker, coverPlacement(checker, 1, 0, 0));

  expect(samples).toHaveLength(PIXEL_COUNT);
  expect(samples.every((sample) => sample !== null)).toBe(true);
  for (const sample of samples) {
    expect(sample!.r).toBeCloseTo(127.5);
    expect(sample!.g).toBeCloseTo(127.5);
    expect(sample!.b).toBeCloseTo(127.5);
  }
});

test("a chip pixel the image does not reach takes no colour at all", () => {
  const solid = raster(62, 62, () => RED);

  // Shoved off the chip entirely.
  const gone = sampleChip(solid, coverPlacement(solid, 1, 100, 0));
  expect(gone.every((sample) => sample === null)).toBe(true);

  // Half off: the pixels it still covers are sampled, the rest are left alone.
  const half = sampleChip(solid, coverPlacement(solid, 1, 16, 0));
  expect(half[pixelIndexAt(4, 15)!]).toBeNull();
  expect(half[pixelIndexAt(26, 15)!]).not.toBeNull();

  // Transparent is absent rather than black: a cut-out leaves the chip alone.
  const cutout = raster(62, 62, (x) => (x < SPLIT ? RED : CLEAR));
  const punched = sampleChip(cutout, coverPlacement(cutout, 1, 0, 0));
  expect(punched[pixelIndexAt(5, 15)!]).toEqual({ r: 255, g: 0, b: 0 });
  expect(punched[pixelIndexAt(25, 15)!]).toBeNull();
});

test("a picture magnified past its own pixels still samples", () => {
  // One image pixel stretched over the whole chip: no chip pixel contains a
  // pixel centre, so each one has to take the colour underneath it.
  const single = raster(1, 1, () => BLUE);
  const samples = sampleChip(single, coverPlacement(single, 1, 0, 0));
  expect(samples.every((sample) => sample?.b === 255)).toBe(true);
});

test("quantise reduces colours and never invents one", () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };

  expect(quantise([], 4)).toEqual([]);
  expect(quantise([black], 0)).toEqual([]);

  // Balanced populations split cleanly down the middle.
  expect(quantise([black, black, white, white], 2)).toEqual([black, white]);

  // One colour, however many copies, is one box: there is nothing to split.
  expect(quantise([black, black, black], 8)).toEqual([black]);

  const spread = [
    { r: 250, g: 10, b: 10 },
    { r: 240, g: 20, b: 0 },
    { r: 10, g: 10, b: 250 },
    { r: 0, g: 20, b: 240 },
    { r: 10, g: 250, b: 10 },
    { r: 0, g: 240, b: 20 },
  ];
  const reduced = quantise(spread, 3);
  expect(reduced.length).toBeLessThanOrEqual(3);
  for (const colour of reduced) {
    // Every representative is an average of real samples, so it lands inside
    // the range the samples occupy.
    expect(colour.r).toBeGreaterThanOrEqual(0);
    expect(colour.r).toBeLessThanOrEqual(250);
    expect(colour.g).toBeLessThanOrEqual(250);
    expect(colour.b).toBeLessThanOrEqual(250);
  }
});

test("with no colour budget the image is approximated in the chip's palette", () => {
  const split = raster(62, 62, (x) => (x < SPLIT ? RED : BLUE));
  const chip = blankChip(["#000000", "#ff0000", "#0000ff"]);
  const stamp = buildStamp(split, coverPlacement(split, 1, 0, 0), chip, 0);

  expect(stamp.palette).toEqual(chip.palette);
  expect(stamp.added).toBe(0);
  expect(stamp.pixels[pixelIndexAt(5, 15)!]).toBe(1);
  expect(stamp.pixels[pixelIndexAt(25, 15)!]).toBe(2);
});

test("a colour budget brings the image's own colours into the palette", () => {
  const solid = raster(62, 62, () => [17, 34, 51, 255]);
  const chip = blankChip(["#000000", "#ffffff"]);
  const stamp = buildStamp(solid, coverPlacement(solid, 1, 0, 0), chip, 4);

  expect(stamp.added).toBe(1);
  expect(stamp.palette).toEqual(["#000000", "#ffffff", "#112233"]);
  expect([...stamp.pixels].every((pixel) => pixel === 2)).toBe(true);

  // Half the chip, half the picture: the pixels it never covers keep the
  // colour they had rather than being cleared to something.
  const painted = { ...chip, pixels: new Uint8Array(PIXEL_COUNT).fill(1) };
  const partial = buildStamp(solid, coverPlacement(solid, 1, 40, 0), painted, 4);
  expect(partial.added).toBe(0);
  expect([...partial.pixels].every((pixel) => pixel === 1)).toBe(true);
});

test("locked pixels keep their colour and take no part in the budget", () => {
  const split = raster(62, 62, (x) => (x < SPLIT ? RED : BLUE));
  // Everything the red half of the picture lands on is locked.
  const locks = new Uint8Array(PIXEL_COUNT);
  for (let y = 0; y < DIAMETER; y += 1) {
    for (let x = 0; x < 15; x += 1) {
      const index = pixelIndexAt(x, y);
      if (index !== null) locks[index] = 1;
    }
  }
  const chip = { palette: ["#000000"], pixels: new Uint8Array(PIXEL_COUNT), locks };
  const stamp = buildStamp(split, coverPlacement(split, 1, 0, 0), chip, 1);

  // The one colour it could afford went to the half it was allowed to paint.
  expect(stamp.palette).toEqual(["#000000", "#0000ff"]);
  expect(stamp.pixels[pixelIndexAt(5, 15)!]).toBe(0);
  expect(stamp.pixels[pixelIndexAt(25, 15)!]).toBe(1);
});

test("a full palette takes no more colours", () => {
  const solid = raster(62, 62, () => [17, 34, 51, 255]);
  const palette = Array.from({ length: MAX_PALETTE }, (_, index) =>
    formatHexColor({ r: index * 4, g: index * 4, b: index * 4 }),
  );
  const stamp = buildStamp(solid, coverPlacement(solid, 1, 0, 0), blankChip(palette), 8);

  expect(stamp.added).toBe(0);
  expect(stamp.palette).toHaveLength(MAX_PALETTE);
  // Nearest of what was already there, rather than nothing at all. Green
  // carries the most weight, so #112233 lands nearer grey 36 than grey 32.
  expect(stamp.pixels[pixelIndexAt(15, 15)!]).toBe(9);
});
