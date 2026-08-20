// Pattern generators. The ring, spoke, and checker maths comes from
// Planning/circle-bench_1.html, adapted to run over mask indices rather than a
// square raster. The table is the extension point: a fourth generator is one
// more entry, which is why the future-features list costs nothing here.

import { DIAMETER, PIXEL_COUNT, pixelPosition } from "./chip.ts";

export type GeneratorId = "rings" | "spokes" | "grid";

export type GeneratorParam = {
  key: "bands" | "rotation";
  label: string;
  min: number;
  max: number;
  step: number;
};

export type GeneratorOptions = {
  /** Palette indices to cycle through, in band order. */
  paletteIndices: number[];
  bands: number;
  rotation: number;
};

export type Generator = {
  id: GeneratorId;
  label: string;
  description: string;
  params: GeneratorParam[];
  render: (options: GeneratorOptions) => Uint8Array;
};

const CENTER = DIAMETER / 2;
const RADIUS = DIAMETER / 2 + 0.04;

const BANDS_PARAM: GeneratorParam = {
  key: "bands",
  label: "Bands",
  min: 1,
  max: 12,
  step: 1,
};

const ROTATION_PARAM: GeneratorParam = {
  key: "rotation",
  label: "Rotation",
  min: 0,
  max: 360,
  step: 15,
};

function colorFor(options: GeneratorOptions, band: number): number {
  const palette = options.paletteIndices;
  return palette[band % palette.length]!;
}

function eachPixel(
  options: GeneratorOptions,
  band: (dx: number, dy: number, x: number, y: number) => number,
): Uint8Array {
  if (options.paletteIndices.length === 0) {
    throw new Error("A generator needs at least one palette color");
  }
  const pixels = new Uint8Array(PIXEL_COUNT);
  for (let index = 0; index < PIXEL_COUNT; index += 1) {
    const { x, y } = pixelPosition(index);
    const dx = x + 0.5 - CENTER;
    const dy = y + 0.5 - CENTER;
    pixels[index] = colorFor(options, band(dx, dy, x, y));
  }
  return pixels;
}

function bandCount(options: GeneratorOptions): number {
  return Math.max(1, Math.floor(options.bands));
}

export const GENERATORS: readonly Generator[] = [
  {
    id: "rings",
    label: "Concentric rings",
    description: "Bands of color measured out from the center.",
    params: [BANDS_PARAM],
    render: (options) => {
      const bands = bandCount(options);
      const width = RADIUS / bands;
      return eachPixel(options, (dx, dy) =>
        Math.min(bands - 1, Math.floor(Math.hypot(dx, dy) / width)),
      );
    },
  },
  {
    id: "spokes",
    label: "Spokes",
    description: "Wedges of color swept around the center.",
    params: [BANDS_PARAM, ROTATION_PARAM],
    render: (options) => {
      const bands = bandCount(options);
      // A full turn is the identity, so 360 and 0 render the same chip.
      const turn = (((options.rotation % 360) + 360) % 360) / 360;
      return eachPixel(options, (dx, dy) => {
        const angle = (Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2);
        const rotated = (angle + turn) % 1;
        return Math.min(bands - 1, Math.floor(rotated * bands));
      });
    },
  },
  {
    id: "grid",
    label: "Pixel grid",
    description: "A checker of the first two selected colors.",
    params: [BANDS_PARAM],
    render: (options) =>
      eachPixel(options, (_dx, _dy, x, y) => (x + y) % 2),
  },
];

export function generatorById(id: string): Generator {
  const found = GENERATORS.find((generator) => generator.id === id);
  if (!found) throw new Error(`Unknown generator: ${id}`);
  return found;
}

export function renderGenerator(
  id: string,
  options: GeneratorOptions,
): Uint8Array {
  return generatorById(id).render(options);
}
