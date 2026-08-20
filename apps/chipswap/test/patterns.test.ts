import { expect, test } from "bun:test";
import { PIXEL_COUNT, pixelPosition } from "../src/chip.ts";
import { GENERATORS, generatorById, renderGenerator } from "../src/patterns.ts";

const PALETTE = [0, 1, 2, 3];

function options(overrides: Record<string, number> = {}) {
  return {
    paletteIndices: PALETTE,
    bands: 3,
    rotation: 0,
    ...overrides,
  };
}

test("the generator table is what the studio offers", () => {
  expect(GENERATORS.map((generator) => generator.id)).toEqual([
    "rings",
    "spokes",
    "grid",
  ]);
  for (const generator of GENERATORS) {
    expect(generator.label.length).toBeGreaterThan(0);
    expect(generator.params.length).toBeGreaterThan(0);
  }
  expect(generatorById("rings").id).toBe("rings");
  expect(() => generatorById("nope")).toThrow();
});

test("every generator fills exactly the chip with palette indices", () => {
  for (const generator of GENERATORS) {
    const pixels = renderGenerator(generator.id, options());
    expect(pixels.length).toBe(PIXEL_COUNT);
    expect([...pixels].every((value) => PALETTE.includes(value))).toBe(true);
  }
});

test("generators are deterministic", () => {
  for (const generator of GENERATORS) {
    const first = renderGenerator(generator.id, options());
    const second = renderGenerator(generator.id, options());
    expect([...first]).toEqual([...second]);
  }
});

test("rings are uniform at one band and monotonic outward", () => {
  const single = renderGenerator("rings", options({ bands: 1 }));
  expect(new Set([...single]).size).toBe(1);

  const three = renderGenerator("rings", options({ bands: 3 }));
  expect(new Set([...three]).size).toBe(3);

  // Band index never decreases as a pixel gets further from the center.
  const center = 31 / 2;
  const samples = [...three].map((value, index) => {
    const { x, y } = pixelPosition(index);
    const dx = x + 0.5 - center;
    const dy = y + 0.5 - center;
    return { distance: Math.hypot(dx, dy), band: PALETTE.indexOf(value) };
  });
  samples.sort((left, right) => left.distance - right.distance);
  let highest = -1;
  for (const sample of samples) {
    expect(sample.band).toBeGreaterThanOrEqual(highest);
    highest = Math.max(highest, sample.band);
  }
});

test("spokes divide the chip into contiguous angular runs", () => {
  const four = renderGenerator("spokes", options({ bands: 4 }));
  expect(new Set([...four]).size).toBe(4);

  const center = 31 / 2;
  const byAngle = [...four]
    .map((value, index) => {
      const { x, y } = pixelPosition(index);
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      return { angle: Math.atan2(dy, dx), band: PALETTE.indexOf(value) };
    })
    .sort((left, right) => left.angle - right.angle);

  // Each band is one contiguous arc, so walking the circle once crosses exactly
  // as many boundaries as there are bands. The count is circular: the pixels
  // lying exactly on the wrap ray belong to the arc that continues past it.
  let changes = 0;
  for (let index = 0; index < byAngle.length; index += 1) {
    const previous = byAngle[(index + byAngle.length - 1) % byAngle.length]!;
    if (byAngle[index]!.band !== previous.band) changes += 1;
  }
  expect(changes).toBe(4);
});

test("rotating the spokes moves the boundaries", () => {
  const base = renderGenerator("spokes", options({ bands: 4, rotation: 0 }));
  const turned = renderGenerator("spokes", options({ bands: 4, rotation: 45 }));
  expect([...base]).not.toEqual([...turned]);

  // A full turn is the identity.
  const full = renderGenerator("spokes", options({ bands: 4, rotation: 360 }));
  expect([...full]).toEqual([...base]);
});

test("the grid alternates on x plus y", () => {
  const grid = renderGenerator("grid", options());
  for (const [index, value] of [...grid].entries()) {
    const { x, y } = pixelPosition(index);
    expect(value).toBe(PALETTE[(x + y) % 2]!);
  }
});

test("a generator falls back safely when the palette selection is short", () => {
  const pixels = renderGenerator("rings", {
    paletteIndices: [5],
    bands: 4,
    rotation: 0,
  });
  expect(pixels.length).toBe(PIXEL_COUNT);
  expect(new Set([...pixels])).toEqual(new Set([5]));
  expect(() =>
    renderGenerator("rings", { paletteIndices: [], bands: 3, rotation: 0 }),
  ).toThrow();
});
