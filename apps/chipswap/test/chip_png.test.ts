import { expect, test } from "bun:test";
import { DIAMETER, PIXEL_COUNT, pixelIndexAt } from "../src/chip.ts";
import { chipFileName, chipRgba } from "../src/chip_png.ts";

/** A chip painted entirely with one palette index. */
const solid = (index: number) => new Uint8Array(PIXEL_COUNT).fill(index);

const at = (rgba: Uint8ClampedArray, x: number, y: number) => {
  const offset = (y * DIAMETER + x) * 4;
  return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
};

test("the raster is a 31x31 RGBA square", () => {
  const rgba = chipRgba(solid(0), ["#7fd1c1"]);
  expect(rgba.length).toBe(DIAMETER * DIAMETER * 4);
});

// The corners of the square are not chip pixels. A download that filled them
// would put a background nobody painted into the picture.
test("every cell outside the circular mask is fully transparent", () => {
  const rgba = chipRgba(solid(0), ["#7fd1c1"]);
  for (let y = 0; y < DIAMETER; y += 1) {
    for (let x = 0; x < DIAMETER; x += 1) {
      if (pixelIndexAt(x, y) !== null) continue;
      expect(at(rgba, x, y)).toEqual([0, 0, 0, 0]);
    }
  }
  expect(at(rgba, 0, 0)).toEqual([0, 0, 0, 0]);
  expect(at(rgba, 30, 30)).toEqual([0, 0, 0, 0]);
});

test("every chip pixel takes its palette color at full opacity", () => {
  const rgba = chipRgba(solid(0), ["#7fd1c1"]);
  for (let y = 0; y < DIAMETER; y += 1) {
    for (let x = 0; x < DIAMETER; x += 1) {
      if (pixelIndexAt(x, y) === null) continue;
      expect(at(rgba, x, y)).toEqual([0x7f, 0xd1, 0xc1, 255]);
    }
  }
});

test("each pixel reads its own palette entry", () => {
  const pixels = new Uint8Array(PIXEL_COUNT).fill(1);
  pixels[pixelIndexAt(15, 15)!] = 2;
  const rgba = chipRgba(pixels, ["#000000", "#112233", "#445566"]);
  expect(at(rgba, 15, 15)).toEqual([0x44, 0x55, 0x66, 255]);
  expect(at(rgba, 14, 15)).toEqual([0x11, 0x22, 0x33, 255]);
});

// Matching the on-screen canvas exactly: a chip whose art outlived a palette
// entry still downloads, rather than throwing on the way out.
test("an index past the palette falls back to black instead of throwing", () => {
  const rgba = chipRgba(solid(9), ["#7fd1c1"]);
  expect(at(rgba, 15, 15)).toEqual([0, 0, 0, 255]);
});

test("a malformed palette entry falls back to black instead of throwing", () => {
  const rgba = chipRgba(solid(0), ["not a color"]);
  expect(at(rgba, 15, 15)).toEqual([0, 0, 0, 255]);
});

test("the file name carries the title, the serial and the pixel size", () => {
  expect(chipFileName("Moonrise", 4, 1)).toBe("moonrise-4-31px.png");
  expect(chipFileName("Moonrise", 4, 16)).toBe("moonrise-4-496px.png");
});

// Our own designs are in the collection too, and they have no serial.
test("a chip with no serial is named without one", () => {
  expect(chipFileName("Moonrise", null, 1)).toBe("moonrise-31px.png");
});

test("a title becomes one lowercase hyphenated run of its words", () => {
  expect(chipFileName("  Blue   Moon Rising! ", 7, 1)).toBe(
    "blue-moon-rising-7-31px.png",
  );
  expect(chipFileName("Café", 7, 1)).toBe("caf-7-31px.png");
});

// A title of nothing but punctuation still has to produce a usable name.
test("a title with nothing to slug falls back to a generic name", () => {
  expect(chipFileName("!!!", 7, 1)).toBe("chip-7-31px.png");
  expect(chipFileName("", null, 16)).toBe("chip-496px.png");
});

// The rest of the download is canvas and Blob work, which `bun test` has no DOM
// to run. These guard the two things that would fail silently in a browser and
// look fine in review, the way filters_disclosure.test.ts guards the CSS rule
// that makes `hidden` bite.
const source = await Bun.file(new URL("../src/chip_png.ts", import.meta.url).pathname).text();

// Smoothing on turns a 16x chip into a blurred circle and feathers the
// transparent border into a grey halo. The whole point of the big size is that
// it is the small one, exactly.
test("the scaled draw turns off image smoothing", () => {
  expect(source).toContain("imageSmoothingEnabled = false");
});

// A download started inside the app frame is refused by the sandbox, whether
// script clicks the anchor or a person does. Nothing here may quietly go back
// to trying one: the data URL in the save panel is the whole route out.
test("no download path survives, because the app frame may not download", () => {
  expect(source).not.toContain("createObjectURL");
  expect(source).not.toContain(".download =");
});

test("the PNG is produced as a data URL", () => {
  expect(source).toContain("toDataURL(\"image/png\")");
});
