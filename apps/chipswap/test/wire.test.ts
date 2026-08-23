import { expect, test } from "bun:test";
import { decodeCatalogReply } from "../src/wire.ts";
import { PIXEL_COUNT, SHAPE_ID } from "../src/chip.ts";
import fixtures from "./fixtures/catalog_wire.json" with { type: "json" };

// The same bytes test/wire_fixtures.test.mo reads. Two decoders of one
// hand-rolled format is the classic place for a slow drift, so neither suite
// gets its own fixtures.

function bytes(hex: string): Uint8Array {
  const pairs = hex.match(/../g) ?? [];
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

test("an empty catalog decodes to no designs", () => {
  expect(decodeCatalogReply(bytes(fixtures.valid.empty))).toEqual([]);
});

test("an unrestricted design decodes with its art and open requirements", () => {
  const designs = decodeCatalogReply(bytes(fixtures.valid.open_single));
  expect(designs).not.toBeNull();
  expect(designs).toHaveLength(1);
  const design = designs![0];
  expect(design.designId).toBe(1);
  expect(design.title).toBe("Open Water");
  expect(design.nsfw).toBe(false);
  expect(design.designRevision).toBe("4");
  expect(design.publishedAtNs).toBe("1600000000000000000");
  expect(design.art.shapeId).toBe(SHAPE_ID);
  expect(design.art.palette).toEqual(["#000000", "#010203", "#020406"]);
  expect(design.art.pixels).toHaveLength(PIXEL_COUNT * 2);
  expect(design.requirements).toEqual({
    approval: false,
    minColors: null,
    maxCoverage: null,
    nsfw: "any",
  });
});

test("a restricted design carries every requirement and a u64 revision intact", () => {
  const designs = decodeCatalogReply(bytes(fixtures.valid.strict_single));
  expect(designs).not.toBeNull();
  const design = designs![0];
  expect(design.title).toBe("Sunrise é中");
  expect(design.nsfw).toBe(true);
  expect(design.requirements).toEqual({
    approval: true,
    minColors: 6,
    maxCoverage: 40,
    nsfw: "disallowed",
  });
  // A u64 past Number.MAX_SAFE_INTEGER must survive as text, not round.
  expect(design.designRevision).toBe("18446744073709551615");
});

test("the required-tag rule decodes distinctly from disallowed", () => {
  const designs = decodeCatalogReply(bytes(fixtures.valid.required_tag));
  expect(designs![0].requirements.nsfw).toBe("required");
});

test("a multi-design catalog keeps its order", () => {
  const designs = decodeCatalogReply(bytes(fixtures.valid.three));
  expect(designs?.map((design) => design.designId)).toEqual([1, 9, 2]);
});

test("a full ten-design catalog is accepted", () => {
  expect(decodeCatalogReply(bytes(fixtures.valid.full_ten))).toHaveLength(10);
});

// Every refusal is a message a hostile peer could send. None may be repaired,
// and none may yield a partial catalog.
test.each(Object.keys(fixtures.invalid))("%s is refused", (name) => {
  const hex = (fixtures.invalid as Record<string, string>)[name];
  expect(decodeCatalogReply(bytes(hex))).toBeNull();
});

test("a message past the size ceiling is refused before it is read", () => {
  expect(decodeCatalogReply(new Uint8Array(65_537))).toBeNull();
});

test("an empty input is refused rather than read as an empty catalog", () => {
  expect(decodeCatalogReply(new Uint8Array(0))).toBeNull();
});
