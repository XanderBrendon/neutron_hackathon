// The CSW1 peer reply wire, read side, ported from backend/Wire.mo.
//
// A catalog reply is not Candid. It is the hand-rolled format the peer routes
// speak, and it arrives from a canister we do not control, so every read is
// bounds-checked and a failed read latches. A message that is wrong in any way
// is refused whole: this decoder never repairs, never clamps, and never
// returns a partial catalog. Divergence from Wire.mo is a bug in one of the
// two, which is why test/fixtures/catalog_wire.json is read by both suites.
//
// The two u64 fields travel out of here as decimal strings. They do not fit a
// JS number exactly, and rounding one where Motoko does not would be exactly
// the drift the shared fixtures exist to prevent.

import { MAX_PALETTE, PIXEL_COUNT, SHAPE_ID, encodeHex } from "./chip.ts";
import type { NsfwRule, TradeRequirements } from "./requirements.ts";

export const MAGIC = [0x43, 0x53, 0x57, 0x31] as const; // CSW1
export const WIRE_VERSION = 3;
export const MAX_MESSAGE_BYTES = 65_536;
export const MAX_DESIGNS = 10;
export const MAX_TITLE_BYTES = 192;
export const MAX_SHAPE_ID_BYTES = 32;

const TYPE_CATALOG = 1;

const FLAG_APPROVAL = 1;
const FLAG_MIN_COLORS = 2;
const FLAG_MAX_COVERAGE = 4;
const FLAG_NSFW_RULE = 8;
const FLAG_NSFW_REQUIRED = 16;
const FLAG_KNOWN = 31;

const MIN_COLORS_FLOOR = 2;
const MAX_COVERAGE_FLOOR = 1;
const MAX_COVERAGE_CEILING = 99;

export type PeerArt = {
  shapeId: string;
  /** Lowercase `#rrggbb`, matching colorText in backend/main.mo. */
  palette: string[];
  /** PIXEL_COUNT bytes as lowercase hex, matching the tile's Art. */
  pixels: string;
};

export type PeerDesign = {
  designId: number;
  title: string;
  art: PeerArt;
  requirements: TradeRequirements;
  nsfw: boolean;
  /** u64 as a decimal string. */
  designRevision: string;
  /** u64 nanoseconds as a decimal string. */
  publishedAtNs: string;
};

/** Bounds-checked cursor. A failed read latches, so callers check once. */
class Reader {
  private offset = 0;
  private failed = false;

  constructor(private readonly bytes: Uint8Array) {}

  get ok(): boolean {
    return !this.failed;
  }

  get done(): boolean {
    return !this.failed && this.offset === this.bytes.length;
  }

  skip(length: number): void {
    this.raw(length);
  }

  u8(): number {
    if (this.failed || this.offset >= this.bytes.length) {
      this.failed = true;
      return 0;
    }
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  u16(): number {
    const high = this.u8();
    return high * 256 + this.u8();
  }

  u32(): number {
    const high = this.u16();
    return high * 65_536 + this.u16();
  }

  /** Returned as a decimal string: the range exceeds a JS number. */
  u64(): string {
    const high = BigInt(this.u32());
    const low = BigInt(this.u32());
    return (high * 4_294_967_296n + low).toString();
  }

  raw(length: number): Uint8Array {
    if (
      this.failed ||
      length > this.bytes.length ||
      this.offset > this.bytes.length - length
    ) {
      this.failed = true;
      return new Uint8Array(0);
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  text(limit: number): string {
    const length = this.u16();
    if (length > limit) {
      this.failed = true;
      return "";
    }
    const raw = this.raw(length);
    if (this.failed) return "";
    try {
      // A lone surrogate or a bad continuation byte is not text we were sent.
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      this.failed = true;
      return "";
    }
  }

  blob(limit: number): Uint8Array {
    const length = this.u16();
    if (length > limit) {
      this.failed = true;
      return new Uint8Array(0);
    }
    return this.raw(length);
  }

  /** Anything but 0 or 1 would be a second spelling of one message. */
  flag(): boolean {
    const value = this.u8();
    if (value === 0) return false;
    if (value === 1) return true;
    this.failed = true;
    return false;
  }
}

function has(flags: number, bit: number): boolean {
  return Math.floor(flags / bit) % 2 === 1;
}

/** Matches colorText in backend/main.mo: low 24 bits, lowercase, #-prefixed. */
function colorText(value: number): string {
  return `#${(value % 16_777_216).toString(16).padStart(6, "0")}`;
}

function open(bytes: Uint8Array, expected: number): Reader | null {
  if (bytes.length < MAGIC.length + 2) return null;
  if (bytes.length > MAX_MESSAGE_BYTES) return null;
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) return null;
  }
  if (bytes[MAGIC.length] !== expected) return null;
  if (bytes[MAGIC.length + 1] !== WIRE_VERSION) return null;
  const reader = new Reader(bytes);
  reader.skip(MAGIC.length + 2);
  return reader;
}

function readArt(reader: Reader): PeerArt | null {
  const shapeId = reader.text(MAX_SHAPE_ID_BYTES);
  const paletteSize = reader.u16();
  if (!reader.ok || paletteSize === 0 || paletteSize > MAX_PALETTE) return null;
  const palette: string[] = [];
  for (let index = 0; index < paletteSize; index += 1) {
    palette.push(colorText(reader.u32()));
  }
  const pixels = reader.blob(PIXEL_COUNT);
  if (!reader.ok) return null;
  // Art that does not describe a chip we can render is refused here, not
  // repaired later. This mirrors Shape.validateArt.
  if (shapeId !== SHAPE_ID) return null;
  if (pixels.length !== PIXEL_COUNT) return null;
  for (const index of pixels) {
    if (index >= paletteSize) return null;
  }
  return { shapeId, palette, pixels: encodeHex(pixels) };
}

function readRequirements(reader: Reader): TradeRequirements | null {
  const flags = reader.u8();
  if (!reader.ok) return null;
  if (flags > FLAG_KNOWN) return null;
  // The `required` bit alone would be a second spelling of "no rule".
  if (has(flags, FLAG_NSFW_REQUIRED) && !has(flags, FLAG_NSFW_RULE)) return null;

  let minColors: number | null = null;
  if (has(flags, FLAG_MIN_COLORS)) {
    const value = reader.u8();
    if (value < MIN_COLORS_FLOOR || value > MAX_PALETTE) return null;
    minColors = value;
  }
  let maxCoverage: number | null = null;
  if (has(flags, FLAG_MAX_COVERAGE)) {
    const value = reader.u8();
    if (value < MAX_COVERAGE_FLOOR || value > MAX_COVERAGE_CEILING) return null;
    maxCoverage = value;
  }
  if (!reader.ok) return null;

  const nsfw: NsfwRule = !has(flags, FLAG_NSFW_RULE)
    ? "any"
    : has(flags, FLAG_NSFW_REQUIRED)
      ? "required"
      : "disallowed";

  return { approval: has(flags, FLAG_APPROVAL), minColors, maxCoverage, nsfw };
}

function readDesign(reader: Reader): PeerDesign | null {
  const designId = reader.u16();
  const title = reader.text(MAX_TITLE_BYTES);
  if (!reader.ok) return null;
  const art = readArt(reader);
  if (art === null) return null;
  const requirements = readRequirements(reader);
  if (requirements === null) return null;
  const nsfw = reader.flag();
  const designRevision = reader.u64();
  const publishedAtNs = reader.u64();
  if (!reader.ok) return null;
  return {
    designId,
    title,
    art,
    requirements,
    nsfw,
    designRevision,
    publishedAtNs,
  };
}

/** null means the message was not one we can read. There is no partial read. */
export function decodeCatalogReply(bytes: Uint8Array): PeerDesign[] | null {
  const reader = open(bytes, TYPE_CATALOG);
  if (reader === null) return null;
  const count = reader.u16();
  if (!reader.ok || count > MAX_DESIGNS) return null;
  const designs: PeerDesign[] = [];
  for (let index = 0; index < count; index += 1) {
    if (!reader.ok) return null;
    const design = readDesign(reader);
    if (design === null) return null;
    designs.push(design);
  }
  if (!reader.done) return null;
  return designs;
}
