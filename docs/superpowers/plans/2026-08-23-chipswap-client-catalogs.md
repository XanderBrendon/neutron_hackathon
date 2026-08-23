# Chipswap Client-Fetched Catalogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move peer catalog fetching out of the Chipswap canister and into the browser, backed by a persistent per-installation cache with a one-day per-designer TTL.

**Architecture:** Delete `chipswap_store`, `chipswap_fetch_catalogs`, and `mem.catalog_cache`. Widen the `catalog` public-ingress route to `caller: "any"` so an anonymous browser query is admitted. Add a resident background process with `persistent_browser_storage` that queries peers with `@dfinity/agent`, decodes the hand-rolled CSW1 binary reply with a new TypeScript port, and keeps results in IndexedDB. The Market tile reads that cache and does its own filtering, sorting, and paging. Propose-time design verification moves from the deleted cache to a live free query against the peer.

**Tech Stack:** Motoko (`mo:core`), TypeScript, React 19, esbuild, bun test, `@dfinity/agent`, `@dfinity/candid`, `@dfinity/principal`, `neutron-tools/app`.

**Spec:** `docs/superpowers/specs/2026-08-23-chipswap-client-catalogs-design.md`

## Global Constraints

- All work is inside `apps/chipswap/`. Run every command from that directory.
- Motoko persistent schemas under `backend/memory/chipswap/` are **immutable after release**. Never edit `v1.mo`–`v5.mo`; add `v6.mo` and `v5_to_v6.mo`.
- Motoko schema files forbid relative imports except to sibling schema versions. Package imports (`mo:core/...`) are allowed.
- The CSW1 wire format is frozen at `WIRE_VERSION = 3`. Do not change `backend/Wire.mo`'s format.
- Wire caps, copied verbatim: `MAGIC = [0x43, 0x53, 0x57, 0x31]`, `WIRE_VERSION = 3`, `MAX_MESSAGE_BYTES = 65_536`, `MAX_DESIGNS = 10`, `MAX_TITLE_BYTES = 192`, `MAX_SHAPE_ID_BYTES = 32`, `MAX_PRINCIPAL_BYTES = 29`, `FLAG_KNOWN = 31`, `MIN_COLORS_FLOOR = 2`, `MAX_COVERAGE_FLOOR = 1`, `MAX_COVERAGE_CEILING = 99`.
- Chip geometry, copied verbatim: `SHAPE_ID = "circle31"`, `PIXEL_COUNT = 757`, `MAX_PALETTE = 64`.
- `CATALOG_TTL_MS = 86_400_000`. `MAX_REFRESH_CONCURRENCY = 8`.
- Manifest version goes 115 → 116. Memory version goes 5 → 6.
- `u64` wire fields (`design_revision`, `published_at_ns`) travel as **decimal strings** in TypeScript. They exceed `Number.MAX_SAFE_INTEGER`, and rounding them in the browser where Motoko does not would be a decoder divergence.
- Palette conversion must match `colorText` in `backend/main.mo:1741` exactly: mask to the low 24 bits (`% 16_777_216`), then lowercase hex, `#`-prefixed.
- Run `npm test` from `apps/chipswap/` for the full suite (packages, then `bun test`, then the Motoko suite). Run `bun test test/<file>` for one TS file and `bun ../../packages/neutron-scripts/src/run_motoko_program.ts test/<file>.mo` for one Motoko file.
- Commit after every task.

---

### Task 1: CSW1 catalog fixtures

Both decoders must agree byte-for-byte, so both read the same checked-in hex. This task produces those fixtures from the Motoko *encoder*, which is the format's source of truth.

**Files:**
- Create: `apps/chipswap/scripts/gen_wire_fixtures.mo`
- Create: `apps/chipswap/test/fixtures/catalog_wire.json`
- Modify: `apps/chipswap/package.json` (add the `fixtures:wire` script)

**Interfaces:**
- Consumes: `backend/Wire.mo`'s `encodeCatalogReply`, `Wire.Design`, `Wire.Art`, `Wire.Requirements`; `backend/Shape.mo`'s `SHAPE_ID`, `PIXEL_COUNT`.
- Produces: `test/fixtures/catalog_wire.json`, an object with a `valid` map and an `invalid` map, both from case name to lowercase hex string. Task 2 and Task 3 both read it.

- [ ] **Step 1: Write the fixture generator**

Create `apps/chipswap/scripts/gen_wire_fixtures.mo`:

```motoko
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Debug "mo:core/Debug";
import Nat8 "mo:core/Nat8";
import Shape "../backend/Shape";
import Wire "../backend/Wire";

// Emits the catalog-wire fixtures both decoder test suites read. The Motoko
// encoder is the format's source of truth, so the valid cases are produced by
// it rather than hand-written. The invalid cases are hand-built byte strings:
// they are messages the encoder cannot produce, which is exactly why a decoder
// has to refuse them.

let HEX : [Text] = [
    "0", "1", "2", "3", "4", "5", "6", "7",
    "8", "9", "a", "b", "c", "d", "e", "f",
];

func hex(blob : Blob) : Text {
    var out = "";
    for (byte in blob.values()) {
        let value = Nat8.toNat(byte);
        out #= HEX[value / 16] # HEX[value % 16];
    };
    out;
};

func art(paletteSize : Nat) : Wire.Art {
    {
        shape_id = Shape.SHAPE_ID;
        palette = Array.tabulate<Nat32>(
            paletteSize,
            func(i) { Nat32.fromNat((i * 0x010203) % 16_777_216) },
        );
        pixels = Blob.fromArray(
            Array.tabulate<Nat8>(
                Shape.PIXEL_COUNT,
                func(i) { Nat8.fromNat(i % paletteSize) },
            )
        );
    };
};

let openDesign : Wire.Design = {
    design_id = 1;
    title = "Open Water";
    art = art(3);
    requirements = {
        approval = false;
        min_colors = null;
        max_coverage = null;
        nsfw = null;
    };
    nsfw = false;
    design_revision = 4;
    published_at_ns = 1_600_000_000_000_000_000;
};

let strictDesign : Wire.Design = {
    design_id = 9;
    title = "Sunrise \u{00e9}\u{4e2d}";
    art = art(8);
    requirements = {
        approval = true;
        min_colors = ?6;
        max_coverage = ?40;
        nsfw = ? #disallowed;
    };
    nsfw = true;
    design_revision = 18_446_744_073_709_551_615;
    published_at_ns = 1_700_000_000_000_000_000;
};

let requiredTag : Wire.Design = {
    strictDesign with
    design_id = 2;
    requirements = {
        approval = false;
        min_colors = null;
        max_coverage = null;
        nsfw = ? #required;
    };
};

// --- Hand-built refusals -------------------------------------------------

func bytesOf(blob : Blob) : [Nat8] = Blob.toArray(blob);

let oneDesign = encodeOne(openDesign);

func encodeOne(design : Wire.Design) : Blob {
    Wire.encodeCatalogReply({ designs = [design] });
};

func mutate(blob : Blob, index : Nat, value : Nat8) : Blob {
    let raw = bytesOf(blob);
    Blob.fromArray(
        Array.tabulate<Nat8>(
            raw.size(),
            func(i) { if (i == index) value else raw[i] },
        )
    );
};

func truncate(blob : Blob, keep : Nat) : Blob {
    let raw = bytesOf(blob);
    Blob.fromArray(Array.tabulate<Nat8>(keep, func(i) { raw[i] }));
};

func append(blob : Blob, extra : [Nat8]) : Blob {
    let raw = bytesOf(blob);
    Blob.fromArray(
        Array.tabulate<Nat8>(
            raw.size() + extra.size(),
            func(i) { if (i < raw.size()) raw[i] else extra[i - raw.size()] },
        )
    );
};

Debug.print("{");
Debug.print("  \"valid\": {");
Debug.print("    \"empty\": \"" # hex(Wire.encodeCatalogReply({ designs = [] })) # "\",");
Debug.print("    \"open_single\": \"" # hex(oneDesign) # "\",");
Debug.print("    \"strict_single\": \"" # hex(encodeOne(strictDesign)) # "\",");
Debug.print("    \"required_tag\": \"" # hex(encodeOne(requiredTag)) # "\",");
Debug.print(
    "    \"three\": \"" # hex(
        Wire.encodeCatalogReply({ designs = [openDesign, strictDesign, requiredTag] })
    ) # "\","
);
Debug.print(
    "    \"full_ten\": \"" # hex(
        Wire.encodeCatalogReply({
            designs = Array.tabulate<Wire.Design>(10, func(i) { { openDesign with design_id = i } });
        })
    ) # "\""
);
Debug.print("  },");
Debug.print("  \"invalid\": {");
// Magic byte 0 flipped.
Debug.print("    \"bad_magic\": \"" # hex(mutate(oneDesign, 0, 0x44)) # "\",");
// Type byte: 5 is the directory message, not a catalog.
Debug.print("    \"wrong_type\": \"" # hex(mutate(oneDesign, 4, 5)) # "\",");
// Version byte: 2 is the previous layout.
Debug.print("    \"old_version\": \"" # hex(mutate(oneDesign, 5, 2)) # "\",");
// Design count u16 raised to 11, one past MAX_DESIGNS.
Debug.print("    \"count_over_max\": \"" # hex(mutate(oneDesign, 7, 11)) # "\",");
// Trailing byte after a complete message.
Debug.print("    \"trailing_byte\": \"" # hex(append(oneDesign, [0])) # "\",");
// Header only: claims one design, carries none.
Debug.print("    \"truncated\": \"" # hex(truncate(oneDesign, 8)) # "\",");
Debug.print("    \"too_short\": \"435357\"");
Debug.print("  }");
Debug.print("}");
```

- [ ] **Step 2: Add the generator script and run it**

In `apps/chipswap/package.json`, add to `scripts`:

```json
"fixtures:wire": "bun ../../packages/neutron-scripts/src/run_motoko_program.ts scripts/gen_wire_fixtures.mo"
```

Run: `npm run fixtures:wire > test/fixtures/catalog_wire.json`

Then open the file and strip any runner banner lines above the leading `{`, so the file is exactly one JSON object. Verify with:

Run: `bun -e 'const f=await Bun.file("test/fixtures/catalog_wire.json").json(); console.log(Object.keys(f.valid), Object.keys(f.invalid))'`
Expected: the six valid keys and the seven invalid keys print.

- [ ] **Step 3: Add the hand-built refusals the encoder cannot produce**

Three refusals require bytes the encoder will never emit, so they are appended to the JSON by hand. Append these entries to the `invalid` object in `test/fixtures/catalog_wire.json`.

Build them with this one-off, which patches the `open_single` fixture at known offsets. Run from `apps/chipswap/`:

```bash
bun -e '
const f = await Bun.file("test/fixtures/catalog_wire.json").json();
const hex = f.valid.open_single;
const b = Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
const at = (i, v) => { const c = b.slice(); c[i] = v; return [...c].map((x) => x.toString(16).padStart(2, "0")).join(""); };
// Header is 6 bytes, then u16 count, then u16 design_id, then u16 title length.
// Title "Open Water" is 10 bytes, so the art shape-id length starts at 20.
const titleLen = 10;
const shapeLenAt = 6 + 2 + 2 + 2 + titleLen;          // u16 length of "circle31"
const paletteLenAt = shapeLenAt + 2 + 8;              // u16 palette entry count
const flagsAt = paletteLenAt + 2 + 3 * 4 + 2 + 757;   // requirements flag byte
f.invalid.palette_empty = at(paletteLenAt + 1, 0);
f.invalid.flags_unknown_bit = at(flagsAt, 32);
f.invalid.nsfw_required_without_rule = at(flagsAt, 16);
await Bun.write("test/fixtures/catalog_wire.json", JSON.stringify(f, null, 2) + "\n");
console.log("added", ["palette_empty", "flags_unknown_bit", "nsfw_required_without_rule"]);
'
```

Expected: prints the three added keys.

- [ ] **Step 4: Prove the Motoko decoder refuses every invalid fixture**

This is the fixture file's own test — if a fixture is not actually invalid, both decoders would "agree" on nonsense.

Create `apps/chipswap/test/wire_fixtures.test.mo`:

```motoko
import Blob "mo:core/Blob";
import Runtime "mo:core/Runtime";
import Wire "../backend/Wire";
import Fixtures "./fixtures/catalog_wire";

// The fixture file is the contract between the Motoko decoder and the
// TypeScript one. A "refusal" fixture that the Motoko decoder happens to
// accept would let both sides agree on a message neither should read, so
// every case is asserted here as well as in test/wire.test.ts.

for ((name, hex) in Fixtures.valid.values()) {
    let ?bytes = Fixtures.unhex(hex) else Runtime.trap("fixture not hex: " # name);
    switch (Wire.decodeCatalogReply(Blob.fromArray(bytes))) {
        case (?_) {};
        case null Runtime.trap("valid fixture refused: " # name);
    };
};

for ((name, hex) in Fixtures.invalid.values()) {
    let ?bytes = Fixtures.unhex(hex) else Runtime.trap("fixture not hex: " # name);
    switch (Wire.decodeCatalogReply(Blob.fromArray(bytes))) {
        case (?_) Runtime.trap("invalid fixture accepted: " # name);
        case null {};
    };
};
```

Because a Motoko test cannot read JSON, generate a Motoko mirror of the fixture file alongside the JSON. Extend `scripts/gen_wire_fixtures.mo` to also write `test/fixtures/catalog_wire.mo` exporting:

```motoko
module {
    public let valid : [(Text, Text)] = [ /* name, hex */ ];
    public let invalid : [(Text, Text)] = [ /* name, hex */ ];
    public func unhex(value : Text) : ?[Nat8] { /* pairwise hex parse, null on odd length or non-hex */ };
}
```

Simplest route: have the generator emit both files by printing the Motoko module after the JSON object, separated by a line reading `---MOTOKO---`, and split the output in the `fixtures:wire` script. Update the script to:

```json
"fixtures:wire": "bun ../../packages/neutron-scripts/src/run_motoko_program.ts scripts/gen_wire_fixtures.mo | bun scripts/split_fixtures.ts"
```

and create `apps/chipswap/scripts/split_fixtures.ts`:

```ts
// The generator prints the JSON fixture object, a separator, then the Motoko
// mirror of the same data. Splitting here keeps one generator as the single
// source for both, so the two files cannot drift.
const input = await Bun.stdin.text();
const marker = "---MOTOKO---";
const index = input.indexOf(marker);
if (index < 0) throw new Error("Generator output carried no Motoko section");
const json = input.slice(0, index).trim();
const motoko = input.slice(index + marker.length).trim();
JSON.parse(json);
await Bun.write("test/fixtures/catalog_wire.json", `${json}\n`);
await Bun.write("test/fixtures/catalog_wire.mo", `${motoko}\n`);
console.log("wrote test/fixtures/catalog_wire.{json,mo}");
```

Re-run `npm run fixtures:wire`, then re-apply Step 3's three hand-built cases to **both** files.

- [ ] **Step 5: Run the Motoko fixture test**

Run: `bun ../../packages/neutron-scripts/src/run_motoko_program.ts test/wire_fixtures.test.mo`
Expected: PASS, no trap.

- [ ] **Step 6: Register the test and commit**

Add `test/wire_fixtures.test.mo` to the `test:motoko` script in `package.json`, immediately after `test/wire.test.mo`.

```bash
git add scripts/gen_wire_fixtures.mo scripts/split_fixtures.ts test/fixtures/ test/wire_fixtures.test.mo package.json
git commit -m "test: CSW1 catalog wire fixtures shared by both decoders"
```

---

### Task 2: TypeScript CSW1 decoder

**Files:**
- Create: `apps/chipswap/src/wire.ts`
- Create: `apps/chipswap/test/wire.test.ts`

**Interfaces:**
- Consumes: `test/fixtures/catalog_wire.json` (Task 1); `SHAPE_ID`, `PIXEL_COUNT`, `MAX_PALETTE`, `encodeHex` from `./chip.ts`; `TradeRequirements`, `NsfwRule` from `./requirements.ts`.
- Produces:
  - `export type PeerArt = { shapeId: string; palette: string[]; pixels: string }`
  - `export type PeerDesign = { designId: number; title: string; art: PeerArt; requirements: TradeRequirements; nsfw: boolean; designRevision: string; publishedAtNs: string }`
  - `export function decodeCatalogReply(bytes: Uint8Array): PeerDesign[] | null`
  - Tasks 7, 8, 9, 10 all consume `PeerDesign`.

- [ ] **Step 1: Write the failing test**

Create `apps/chipswap/test/wire.test.ts`:

```ts
import { expect, test } from "bun:test";
import { decodeCatalogReply } from "../src/wire.ts";
import { PIXEL_COUNT, SHAPE_ID } from "../src/chip.ts";
import fixtures from "./fixtures/catalog_wire.json" with { type: "json" };

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
  expect(design.art.palette).toHaveLength(3);
  expect(design.art.palette[0]).toBe("#000000");
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

// Every refusal is a message a hostile peer could send. None may be repaired.
test.each(Object.keys(fixtures.invalid))("%s is refused", (name) => {
  const hex = (fixtures.invalid as Record<string, string>)[name];
  expect(decodeCatalogReply(bytes(hex))).toBeNull();
});

test("a message past the size ceiling is refused before it is read", () => {
  expect(decodeCatalogReply(new Uint8Array(65_537))).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/wire.test.ts`
Expected: FAIL — cannot resolve `../src/wire.ts`.

- [ ] **Step 3: Write the decoder**

Create `apps/chipswap/src/wire.ts`:

```ts
// The CSW1 peer reply wire, read side, ported from backend/Wire.mo.
//
// A catalog reply is not Candid. It is the hand-rolled format the peer routes
// speak, and it arrives from a canister we do not control, so every read is
// bounds-checked and a failed read latches. A message that is wrong in any way
// is refused whole: this decoder never repairs, never clamps, and never
// returns a partial catalog. Divergence from Wire.mo is a bug in one of the
// two, which is why test/fixtures/catalog_wire.json is read by both.
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

/** Bounds-checked cursor. A failed read latches so callers check once. */
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

  fail(): void {
    this.failed = true;
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

  return {
    approval: has(flags, FLAG_APPROVAL),
    minColors,
    maxCoverage,
    nsfw,
  };
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/wire.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/wire.ts test/wire.test.ts
git commit -m "feat: TypeScript CSW1 catalog decoder"
```

---

### Task 3: Memory v6

**Files:**
- Create: `apps/chipswap/backend/memory/chipswap/v6.mo`
- Create: `apps/chipswap/backend/memory/chipswap/v5_to_v6.mo`
- Create: `apps/chipswap/test/memory_v6.test.mo`
- Modify: `apps/chipswap/test/memory_migration.test.mo`
- Modify: `apps/chipswap/neutron.json` (memory block only)
- Modify: `apps/chipswap/package.json` (`test:motoko` list)

**Interfaces:**
- Consumes: `backend/memory/chipswap/v5.mo`.
- Produces: `V6.Mem` without `catalog_cache`; `V6.DirectoryEntry` without `design_count` and `last_catalog_ns`; `V6.init()`. Tasks 4 and 5 import `./memory/chipswap/v6`.

- [ ] **Step 1: Write the failing test**

Create `apps/chipswap/test/memory_v6.test.mo`:

```motoko
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import V5 "../backend/memory/chipswap/v5";
import V6 "../backend/memory/chipswap/v6";
import Migrate "../backend/memory/chipswap/v5_to_v6";

// V6 removes the peer catalog cache and the two directory fields that only it
// fed. The migration is a projection: nothing is preserved, because the browser
// refetches what used to live here.

let alice = Principal.fromBlob("\00\01\01");

let old = V5.init();
Map.add(
    old.directory,
    Principal.compare,
    alice,
    {
        canister = alice;
        source = #manual;
        first_seen_ns = 10;
        last_seen_ns = 20;
        ignored = false;
        retired = true;
        strikes = 3;
        last_catalog_ns = ?99;
        design_count = 7;
    } : V5.DirectoryEntry,
);
Map.add(
    old.catalog_cache,
    Principal.compare,
    alice,
    { designer = alice; fetched_at_ns = 99; designs = [] } : V5.CachedCatalog,
);
old.revision := 42;

let fresh : V6.Mem = Migrate.migrate(old);

if (fresh.revision != 42) Runtime.trap("revision did not carry across");
if (Map.size(fresh.directory) != 1) Runtime.trap("directory did not carry across");

let ?entry = Map.get(fresh.directory, Principal.compare, alice) else Runtime.trap("entry missing");
if (entry.strikes != 3) Runtime.trap("strikes did not carry across");
if (not entry.retired) Runtime.trap("retired did not carry across");
if (entry.source != #manual) Runtime.trap("source did not carry across");
if (entry.first_seen_ns != 10 or entry.last_seen_ns != 20) {
    Runtime.trap("timestamps did not carry across");
};

// A clean V6 install has the seed directory V5 introduced and nothing else.
let clean = V6.init();
if (Map.size(clean.directory) == 0) Runtime.trap("V6 install lost its seed");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun ../../packages/neutron-scripts/src/run_motoko_program.ts test/memory_v6.test.mo`
Expected: FAIL — cannot find `../backend/memory/chipswap/v6`.

- [ ] **Step 3: Write the v6 schema**

Copy `backend/memory/chipswap/v5.mo` to `backend/memory/chipswap/v6.mo`, then apply exactly these changes:

1. Replace the leading comment block with:

```motoko
// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
//
// V6 stops storing other designers' work. The peer catalog cache held up to
// MAX_CATALOG_CACHE designers' full published catalogs — title, palette, and
// 757 pixel indices per design — inside a canister whose purpose is this
// owner's own chips. The browser now fetches catalogs directly and keeps them
// on the machine that asked for them, where their age is visible and their
// storage is not the owner's to pay for.
//
// `design_count` and `last_catalog_ns` go with it. Both described the cache
// rather than the designer, and a count kept after the thing it counted was
// removed would be a number that drifts silently. The directory keeps what it
// actually knows: who this designer is, how we met them, whether they answer,
// and whether the owner wants to hear from them.
//
// Every other type is V5's, unchanged.
```

2. Delete the `CachedDesign` and `CachedCatalog` types.
3. In `DirectoryEntry`, delete the `last_catalog_ns : ?Int;` and `design_count : Nat;` fields.
4. In `Mem`, delete the `catalog_cache : Map.Map<Principal, CachedCatalog>;` field.
5. Update `init()` to drop `catalog_cache` from the record it builds, and to build its seed directory entries without the two removed fields.

- [ ] **Step 4: Write the migration**

Create `apps/chipswap/backend/memory/chipswap/v5_to_v6.mo`:

```motoko
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import V5 "./v5";
import V6 "./v6";

// The cache is dropped rather than carried: what it held is public, the
// browser refetches it, and a copy left behind would be a stale one nobody
// reads. `design_count` and `last_catalog_ns` described that cache, so they
// leave with it.
//
// The directory itself is the owner's and carries across entry by entry. The
// rebuild below is a retyping, not a rewrite: Map is invariant in its value
// type, so a Map of V5 entries cannot stand in for a Map of V6 entries even
// though every field V6 keeps is already there.
module {
    public func migrate(old : V5.Mem) : V6.Mem {
        let directory = Map.empty<Principal, V6.DirectoryEntry>();
        for ((canister, entry) in Map.entries(old.directory)) {
            Map.add(
                directory,
                Principal.compare,
                canister,
                {
                    canister = entry.canister;
                    source = entry.source;
                    first_seen_ns = entry.first_seen_ns;
                    last_seen_ns = entry.last_seen_ns;
                    ignored = entry.ignored;
                    retired = entry.retired;
                    strikes = entry.strikes;
                } : V6.DirectoryEntry,
            );
        };

        {
            var revision = old.revision;
            var next_request_seq = old.next_request_seq;
            var next_brush_id = old.next_brush_id;
            var crawl = null;
            designs = old.designs;
            holdings = old.holdings;
            directory;
            incoming = old.incoming;
            outgoing = old.outgoing;
            replay = old.replay;
            brushes = old.brushes;
        };
    };
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun ../../packages/neutron-scripts/src/run_motoko_program.ts test/memory_v6.test.mo`
Expected: PASS.

- [ ] **Step 6: Extend the migration chain test**

In `apps/chipswap/test/memory_migration.test.mo`, extend the existing v1→v5 chain by one step so it runs v1→v6. Append after the existing v4→v5 assertions:

```motoko
import MigrateV5V6 "../backend/memory/chipswap/v5_to_v6";
import V6 "../backend/memory/chipswap/v6";

// The whole chain still lands somewhere readable. A directory that entered at
// V1 must still be the same directory at V6, minus only the two fields V6
// deliberately drops.
let v6 : V6.Mem = MigrateV5V6.migrate(v5);
if (Map.size(v6.directory) != Map.size(v5.directory)) {
    Runtime.trap("v5 -> v6 changed the directory size");
};
if (v6.revision != v5.revision) Runtime.trap("v5 -> v6 lost the revision");
```

Adjust the local variable names to match whatever the existing file already binds for the v5 result.

- [ ] **Step 7: Update the manifest memory block**

In `apps/chipswap/neutron.json`, set `memory.chipswap.version` to `6`, add to `schemas`:

```json
"6": { "src": "memory/chipswap/v6.mo" }
```

and add to `migrations`:

```json
{ "from": 5, "to": 6, "src": "memory/chipswap/v5_to_v6.mo" }
```

- [ ] **Step 8: Register the tests and commit**

Add `test/memory_v6.test.mo` to the `test:motoko` script in `package.json`, after `test/memory_v5.test.mo`.

Run: `bun ../../packages/neutron-scripts/src/run_motoko_program.ts test/memory_migration.test.mo`
Expected: PASS.

```bash
git add backend/memory/chipswap/v6.mo backend/memory/chipswap/v5_to_v6.mo test/memory_v6.test.mo test/memory_migration.test.mo neutron.json package.json
git commit -m "feat: memory v6 drops the peer catalog cache"
```

---

### Task 4: Remove the backend catalog cache

**Files:**
- Modify: `apps/chipswap/backend/main.mo`
- Modify: `apps/chipswap/backend/Directory.mo`
- Modify: `apps/chipswap/neutron.json` (`func`, `preapproved_self_calls`)
- Modify: `apps/chipswap/test/directory.test.mo`
- Modify: `apps/chipswap/test/main.test.mo`

**Interfaces:**
- Consumes: `V6.Mem` (Task 3).
- Produces: a `Directory` module without `storeCatalog`, `storeRows`, `validFilter`, `cachedDesign`, `StoreRow`, `StoreFilter`; a `main.mo` without `chipswap_store` and `chipswap_fetch_catalogs`. Task 5 rebuilds the propose guard on top of this.

- [ ] **Step 1: Point the backend at v6 and delete the cache readers**

In `backend/main.mo`, change the memory import:

```motoko
import Memory "./memory/chipswap/v6";
```

Then delete, in order:

1. The `chipswap_store` method (`backend/main.mo:600-648`) and the `StoreRequest`, `StorePage`, `StoreRowView` type declarations.
2. The `chipswap_fetch_catalogs` method (`backend/main.mo:1087-1170`) and the `FetchCatalogsRequest`, `FetchCatalogsResult`, `PeerCatalogRequest`-adjacent result types that no other method names. Keep `PeerCatalogRequest` itself — Task 5 sends it.
3. `let MAX_FETCH_TARGETS : Nat = 8;`.
4. `catalog_designers = Map.size(mem.catalog_cache);` from the `chipswap_status` record, and `catalog_designers : Nat;` from `StatusView`.
5. `design_count` and `last_catalog_ns` from the `chipswap_directory` row builder and from `DirectoryEntryView`.
6. The `catalogFromResult` helper if Task 5 has not yet claimed it — it is reinstated there, so leaving it in place is also fine.

- [ ] **Step 2: Prune the Directory module**

In `backend/Directory.mo`, delete: `storeCatalog`, `storeRows`, `validFilter`, `cachedDesign`, the `StoreRow` and `StoreFilter` types, the `StorePage` type, and the `ordered` / sort-rank helpers that only `storeRows` called. Also delete `MAX_CATALOG_CACHE` and `MAX_SEARCH_CHARS`.

Remove the catalog-eviction lines from the entry mutators — the ones reading `Map.remove(mem.catalog_cache, ...)` at `Directory.mo:191`, `:210`, `:232`, and `:755`, and the `Map` bookkeeping in the eviction path at `:774` and `:785`.

In the entry constructor around `Directory.mo:79-80`, drop the `last_catalog_ns = null;` and `design_count = 0;` initialisers.

Keep `reachable`, `noteReachable`, `note`, `remove`, `setIgnored`, `setRetired`, `page`, `served`, `startCrawl`, `stopCrawl`, `crawling`, `crawlTargets`, `dropSelf`, `sourceText`. The crawl and the trade routes still use them.

- [ ] **Step 3: Update the manifest**

In `apps/chipswap/neutron.json`, remove `"chipswap_store"` and `"chipswap_fetch_catalogs"` from `capabilities.preapproved_self_calls.methods`, and remove both keys from the `func` map.

- [ ] **Step 4: Prune the Motoko tests**

In `test/directory.test.mo`, delete every case that calls `storeCatalog`, `storeRows`, `validFilter`, or `cachedDesign`, and every assertion on `design_count` or `last_catalog_ns`. Keep the note/ignore/retire/page/served/crawl cases and repoint the file's memory import to `../backend/memory/chipswap/v6`.

In `test/main.test.mo`, delete the `chipswap_store` and `chipswap_fetch_catalogs` cases and repoint its memory import to v6.

Repoint the memory import in every remaining `test/*.test.mo` that names v5 directly — `holdings.test.mo`, `designs.test.mo`, `trades.test.mo`, `contacts_integrity.test.mo` — to v6. Leave `memory_v4.test.mo`, `memory_v5.test.mo`, and `memory_migration.test.mo` alone: they test those versions on purpose.

- [ ] **Step 5: Run the Motoko suite**

Run: `npm run test:motoko`
Expected: PASS. If the compiler reports an unused import or an unreachable helper in `Directory.mo` or `main.mo`, delete it — that is a leftover from a removed method.

- [ ] **Step 6: Commit**

```bash
git add backend/ neutron.json test/
git commit -m "refactor: remove chipswap_store, chipswap_fetch_catalogs, and the catalog cache"
```

---

### Task 5: Propose-time verification against the live peer

**Files:**
- Modify: `apps/chipswap/backend/main.mo` (`chipswap_trade_propose`)
- Modify: `apps/chipswap/backend/Trades.mo` (`beginPropose`)
- Modify: `apps/chipswap/test/trades.test.mo`
- Modify: `apps/chipswap/test/main.test.mo`

**Interfaces:**
- Consumes: `Wire.decodeCatalogReply`, `callRoute`, `ROUTE_CATALOG`, `QUERY_ROUTE_CYCLES` — all already in `main.mo`.
- Produces: `Trades.beginPropose` with the `cachedDesign` gate removed; `chipswap_trade_propose` returning `#err({code = "unknown_design"})` before any mint when the peer does not publish the wanted design.

- [ ] **Step 1: Write the failing test**

In `apps/chipswap/test/trades.test.mo`, add:

```motoko
// beginPropose no longer consults a stored catalog: main.mo verifies the
// design against the peer before calling in. What must still hold here is that
// beginPropose mints or escrows exactly once and leaves nothing behind when a
// later step fails.

let proposal = switch (
    Trades.beginPropose(
        mem,
        { peer = bob; want_design_id = 3; offer = #own(designId) },
        self,
        now,
    )
) {
    case (#err(code)) Runtime.trap("propose refused a design it can no longer check: " # code);
    case (#ok(value)) value;
};
if (proposal.want_design_id != 3) Runtime.trap("proposal lost its target design");
```

Adjust `mem`, `bob`, `self`, `designId`, and `now` to the bindings the existing file already sets up.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun ../../packages/neutron-scripts/src/run_motoko_program.ts test/trades.test.mo`
Expected: FAIL — trap "propose refused a design it can no longer check: unknown_design", because the gate is still present.

- [ ] **Step 3: Remove the gate from `beginPropose`**

In `backend/Trades.mo`, delete these four lines from `beginPropose` (`Trades.mo:156-160`):

```motoko
        // The design must be one we have actually seen in the peer's catalog.
        // Trading blind would spend a chip on a design that may not exist.
        let ?_cached = Directory.cachedDesign(mem, args.peer, args.want_design_id) else {
            return #err("unknown_design");
        };
```

Replace them with:

```motoko
        // Whether the peer really publishes this design is settled before we
        // get here, by a live query in chipswap_trade_propose. It is not
        // checked twice and it is never assumed: nothing below this line mints
        // or escrows until that query has answered.
```

If `Directory` is now unused in `Trades.mo`, remove its import.

- [ ] **Step 4: Run to verify it passes**

Run: `bun ../../packages/neutron-scripts/src/run_motoko_program.ts test/trades.test.mo`
Expected: PASS.

- [ ] **Step 5: Add the live check to `chipswap_trade_propose`**

In `backend/main.mo`, inside `chipswap_trade_propose`, insert between the peer-principal parse and the `Trades.beginPropose` call:

```motoko
            // The design must be one the peer really publishes. The old check
            // read a stored catalog, which could be arbitrarily old; this one
            // asks the peer now. It is a query route, so it costs nothing, and
            // it runs before anything is minted or escrowed — a peer who does
            // not answer cannot be traded with, which is the same conclusion
            // the paid call would have reached one step later and one chip
            // worse off.
            let catalogReply = await* callRoute(
                peer,
                ROUTE_CATALOG,
                to_candid ({} : PeerCatalogRequest),
                QUERY_ROUTE_CYCLES,
                65_536,
            );
            let ?catalogBytes = catalogReply else return #err(error("unknown_design"));
            let ?catalog = Wire.decodeCatalogReply(catalogBytes) else {
                return #err(error("unknown_design"));
            };
            var published = false;
            for (design in catalog.designs.values()) {
                if (design.design_id == request.want_design_id) published := true;
            };
            if (not published) return #err(error("unknown_design"));
```

Confirm `callRoute`'s signature matches this call — it takes `(target, route, payload, cycles, maxResponseBytes)` and returns `?Blob`. If the physical method it uses is the update dispatcher, add a query-route variant alongside it that passes `INGRESS_QUERY_METHOD` instead of `INGRESS_METHOD`, following the shape of the batch calls in `chipswap_crawl_step`.

- [ ] **Step 6: Add the end-to-end cases**

In `apps/chipswap/test/main.test.mo`, add two cases:

```motoko
// A design the peer does not publish costs nothing: no mint, no escrow, and
// no paid call.
let before = Holdings.count(mem);
switch (await* app.chipswap_trade_propose({
    peer = Principal.toText(silentPeer);
    want_design_id = 999;
    offer_kind = "own";
    offer_design_id = ?publishedId;
    offer_chip_key = null;
})) {
    case (#err(payload)) {
        if (payload.code != "unknown_design") {
            Runtime.trap("expected unknown_design, got " # payload.code);
        };
    };
    case (#ok(_)) Runtime.trap("propose succeeded against a peer with no such design");
};
if (Holdings.count(mem) != before) Runtime.trap("a refused propose changed holdings");
```

The second case asserts the same for a peer that does not answer at all. Use whatever peer-stubbing the file already has for the trade routes; if it has none, assert only the no-answer path, which needs no stub because an absent peer returns `null` from `callRoute`.

- [ ] **Step 7: Run the Motoko suite**

Run: `npm run test:motoko`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/main.mo backend/Trades.mo test/trades.test.mo test/main.test.mo
git commit -m "feat: verify a proposed design against the peer instead of a cache"
```

---

### Task 6: Manifest — route policy, background, capability

**Files:**
- Modify: `apps/chipswap/neutron.json`
- Modify: `apps/chipswap/test/package.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the manifest shape Tasks 7–10 build against — `catalog` at `caller: "any"`, a declared `background`, and `persistent_browser_storage`.

- [ ] **Step 1: Write the failing test**

In `apps/chipswap/test/package.test.ts`, add:

```ts
test("the catalog route admits a browser and the trade routes stay paid", async () => {
  const manifest = await readManifest();
  const all = routes(manifest);

  const catalog = all.find((route) => route.id === "catalog");
  // A tile is credentialless and never holds the owner's identity, so a
  // browser-originated query is anonymous. "authenticated" would refuse it and
  // "canister" refuses it today.
  expect(catalog).toMatchObject({ mode: "query", caller: "any" });
  expect(catalog).not.toHaveProperty("required_cycles");

  const directory = all.find((route) => route.id === "directory");
  expect(directory).toMatchObject({ mode: "query", caller: "canister" });

  for (const id of ["trade", "deliver", "status"]) {
    const route = all.find((entry) => entry.id === id);
    expect(route).toMatchObject({ mode: "update", caller: "canister" });
    expect(route?.required_cycles).toBeGreaterThan(0);
  }
});

test("the background is declared with persistent browser storage", async () => {
  const manifest = await readManifest();

  expect(manifest.background).toMatchObject({ path: "service.html" });
  expect(manifest.capabilities?.persistent_browser_storage).toMatchObject({
    api: 1,
    surface: "background",
  });
  // The two are mutually exclusive; declaring both is a packaging failure.
  expect(manifest.capabilities).not.toHaveProperty("dedicated_resident_origin");
});

test("the removed catalog methods are gone from every surface", async () => {
  const manifest = await readManifest();
  const map = funcMap(manifest);
  const preapproved =
    manifest.capabilities?.preapproved_self_calls?.methods ?? [];
  const backend = await readBackend();

  for (const method of ["chipswap_store", "chipswap_fetch_catalogs"]) {
    expect(map).not.toHaveProperty(method);
    expect(preapproved).not.toContain(method);
    expect(backend).not.toContain(method);
  }
  // The cache they fed goes with them.
  expect(backend).not.toContain("catalog_cache");
});

test("the manifest and memory versions advanced together", async () => {
  const manifest = await readManifest();
  expect(manifest.version).toBe(116);
  expect(manifest.memory?.chipswap?.version).toBe(6);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/package.test.ts`
Expected: FAIL on the catalog caller, the background, and the version.

- [ ] **Step 3: Apply the manifest changes**

In `apps/chipswap/neutron.json`:

1. Set `"version": 116`.
2. In the `catalog` route object, change `"caller": "canister"` to `"caller": "any"`.
3. After the `"src": "main.mo"` line, add:

```json
"background": {
  "path": "service.html",
  "description": "Fetch and cache peer catalogs for the market"
},
```

4. In `capabilities`, add:

```json
"persistent_browser_storage": {
  "api": 1,
  "surface": "background"
},
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/package.test.ts`
Expected: the four new tests PASS. The `service.html` asset assertions may still fail — Task 7 creates that file; if the suite blocks on it, move only that assertion into Task 7.

- [ ] **Step 5: Validate the manifest**

Run: `npm run validate`
Expected: no errors. If the validator rejects `persistent_browser_storage` alongside anything else, read `doc/kernel-capability-inventory.md` for the exact accepted shape and correct it.

- [ ] **Step 6: Commit**

```bash
git add neutron.json test/package.test.ts
git commit -m "feat: open the catalog route to browsers and declare the background"
```

---

### Task 7: The resident background

**Files:**
- Create: `apps/chipswap/public/service.html`
- Create: `apps/chipswap/src/resident/service.ts`
- Create: `apps/chipswap/src/resident/agent.ts`
- Create: `apps/chipswap/src/resident/store.ts`
- Modify: `apps/chipswap/build.ts`
- Modify: `apps/chipswap/package.json` (dependencies)

**Interfaces:**
- Consumes: `decodeCatalogReply`, `PeerDesign` (Task 2); `exposeTool`, `publishAppStateChange` from `neutron-tools/app`; `physicalPublicIngressMethodName` from `neutron-tools`.
- Produces:
  - `src/resident/store.ts`: `type CachedCatalog = { designer: string; designs: PeerDesign[]; fetchedAtMs: number; lastError: string | null }`; `readAll(): Promise<CachedCatalog[]>`; `write(entry: CachedCatalog): Promise<void>`; `evict(designers: string[]): Promise<number>`.
  - `src/resident/agent.ts`: `fetchCatalog(designer: string): Promise<{ designs: PeerDesign[] } | { error: string }>`.
  - Three exposed tools: `chipswap_market_catalogs`, `chipswap_market_refresh`, `chipswap_market_evict`. Task 9 and Task 10 call them.

- [ ] **Step 1: Add the agent dependencies**

In `apps/chipswap/package.json`, add to `dependencies`:

```json
"@dfinity/agent": "^3.4.3",
"@dfinity/candid": "^3.4.3",
"@dfinity/principal": "^3.4.3"
```

and remove `@dfinity/candid` from `devDependencies`, since it becomes a runtime dependency.

Run: `npm install`
Expected: completes without error.

- [ ] **Step 2: Write the background document**

Create `apps/chipswap/public/service.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'self'; connect-src 'self' https://*.icp0.io http://localhost:* http://*.localhost:*; base-uri 'none'; form-action 'none'"
    />
    <title>Chipswap catalog service</title>
  </head>
  <body>
    <script type="module" src="./service.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Add the second build entrypoint**

In `apps/chipswap/build.ts`, replace the single-`outfile` config with a two-entrypoint one:

```ts
const config: BuildOptions = {
  entryPoints: ["./src/index.tsx", "./src/resident/service.ts"],
  outdir: "./dist/web",
  entryNames: "[name]",
  bundle: true,
  minify: true,
  external: [],
  format: "esm",
  jsx: "automatic",
  loader: { ".ts": "ts", ".tsx": "tsx" },
  platform: "browser",
  plugins: [ /* unchanged */ ],
};
```

`entryNames: "[name]"` puts `index.tsx` at `dist/web/index.js` — but the tile's HTML loads `./main.js`. Keep the existing name by renaming the tile entry output explicitly:

```ts
  entryPoints: [
    { in: "./src/index.tsx", out: "main" },
    { in: "./src/resident/service.ts", out: "service" },
  ],
  outdir: "./dist/web",
```

and drop the `outfile` field. Update `stripRemoteDiagnostics` to operate on `./dist/web/main.js`, which is unchanged from today.

- [ ] **Step 4: Write the store**

Create `apps/chipswap/src/resident/store.ts`:

```ts
// The catalog cache, on the machine that fetched it.
//
// This runs in the background's persistent origin, which is the only surface
// in the app that keeps anything across a browser restart: a tile's
// credentialless partition is ephemeral and dies with the page. Everything
// here is per-installation and never leaves the machine.

import type { PeerDesign } from "../wire.ts";

export type CachedCatalog = {
  designer: string;
  designs: PeerDesign[];
  /** Wall-clock ms of the last successful read. 0 means never. */
  fetchedAtMs: number;
  /** Why the last attempt failed, or null if it did not. */
  lastError: string | null;
};

const DB_NAME = "chipswap";
const DB_VERSION = 1;
const STORE = "catalogs";

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error("IndexedDB failed"));
  });
}

let cached: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (cached !== null) return cached;
  cached = new Promise((resolve, reject) => {
    const opening = indexedDB.open(DB_NAME, DB_VERSION);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "designer" });
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () =>
      reject(opening.error ?? new Error("Could not open the catalog cache"));
  });
  return cached;
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await open();
  const tx = db.transaction(STORE, mode);
  const result = await run(tx.objectStore(STORE));
  return result;
}

export async function readAll(): Promise<CachedCatalog[]> {
  return transact("readonly", (store) =>
    request(store.getAll() as IDBRequest<CachedCatalog[]>),
  );
}

export async function write(entry: CachedCatalog): Promise<void> {
  await transact("readwrite", async (store) => {
    await request(store.put(entry));
  });
}

/** Returns how many entries actually existed to remove. */
export async function evict(designers: string[]): Promise<number> {
  return transact("readwrite", async (store) => {
    let removed = 0;
    for (const designer of designers) {
      const existing = await request(
        store.get(designer) as IDBRequest<CachedCatalog | undefined>,
      );
      if (existing !== undefined) {
        await request(store.delete(designer));
        removed += 1;
      }
    }
    return removed;
  });
}
```

- [ ] **Step 5: Write the peer agent**

Create `apps/chipswap/src/resident/agent.ts`:

```ts
// One anonymous query to a peer's catalog route.
//
// Three formats are nested here. The outer two are Candid: the ingress
// envelope the dispatcher decodes, and the result variant it answers with. The
// innermost is not — the ok payload is the hand-rolled CSW1 message that
// src/wire.ts reads. Only the middle layer is a protocol we share with the
// kernel; the inner one is Chipswap's own.
//
// The identity is anonymous because it has to be: a tile never holds the
// owner's credentials, and the only owner-identity path prompts per call.
// Query signature verification stays on, so a boundary node cannot forge a
// reply undetected. A peer's own canister can still answer a browser
// differently than it answers a canister, which is why nothing here is trusted
// enough to mint against — see the spec, §8.

import { Actor, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { decodeCatalogReply, type PeerDesign } from "../wire.ts";

const PHYSICAL_METHOD = "app_chipswap__chipswap_v1_query";
const ROUTE_ID = "catalog";

const IngressRequest = IDL.Record({
  method: IDL.Text,
  payload: IDL.Vec(IDL.Nat8),
});

const IngressResult = IDL.Variant({
  ok: IDL.Vec(IDL.Nat8),
  err: IDL.Variant({
    bad_request: IDL.Null,
    not_found: IDL.Null,
    too_large: IDL.Null,
    unauthorized: IDL.Null,
    rate_limited: IDL.Null,
    busy: IDL.Null,
    low_cycles: IDL.Null,
    revoked: IDL.Null,
    revoked_after_dispatch: IDL.Null,
    handler_failed: IDL.Null,
  }),
});

const idlFactory = ({ IDL: idl }: { IDL: typeof IDL }) =>
  idl.Service({
    [PHYSICAL_METHOD]: idl.Func([IngressRequest], [IngressResult], ["query"]),
  });

function gatewayHost(): string {
  // The tile and the background are served from the same gateway the kernel
  // is on, so its origin is the one to talk to rather than a compiled-in host.
  const { protocol, host } = globalThis.location;
  const local = /localhost|127\.0\.0\.1/.test(host);
  return local ? `${protocol}//${host}` : "https://icp0.io";
}

let agentPromise: Promise<HttpAgent> | null = null;

async function agent(): Promise<HttpAgent> {
  if (agentPromise !== null) return agentPromise;
  agentPromise = (async () => {
    const host = gatewayHost();
    const created = await HttpAgent.create({ host });
    // A local replica's root key is not the compiled mainnet one.
    if (host !== "https://icp0.io") await created.fetchRootKey();
    return created;
  })();
  return agentPromise;
}

export type CatalogFetch =
  | { designs: PeerDesign[] }
  | { error: string };

export async function fetchCatalog(designer: string): Promise<CatalogFetch> {
  try {
    const actor = Actor.createActor(idlFactory, {
      agent: await agent(),
      canisterId: designer,
    });
    // The route takes an empty record; Candid for that is a zero-field encode.
    const payload = new Uint8Array(IDL.encode([IDL.Record({})], [{}]));
    const reply = (await actor[PHYSICAL_METHOD]({
      method: ROUTE_ID,
      payload,
    })) as { ok?: Uint8Array | number[]; err?: Record<string, null> };

    if (reply.err !== undefined) {
      const [code] = Object.keys(reply.err);
      // A peer still on caller: "canister" answers unauthorized. That is a
      // release they have not taken yet, not a designer who is gone.
      return { error: code ?? "rejected" };
    }
    if (reply.ok === undefined) return { error: "malformed_reply" };

    const designs = decodeCatalogReply(Uint8Array.from(reply.ok));
    // A message we cannot read is refused whole rather than partly kept.
    if (designs === null) return { error: "undecodable" };
    return { designs };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unreachable" };
  }
}
```

- [ ] **Step 6: Write the service entrypoint**

Create `apps/chipswap/src/resident/service.ts`:

```ts
// The background process. It owns the network and the cache; the tile owns the
// view. Nothing here decides what the market shows — it decides only what has
// been fetched and how old it is.

import { exposeTool, publishAppStateChange } from "neutron-tools/app";
import { fetchCatalog } from "./agent.ts";
import { evict, readAll, write, type CachedCatalog } from "./store.ts";
import { staleDesigners } from "./freshness.ts";

/** One day. A catalog older than this is refetched when the Market opens. */
export const CATALOG_TTL_MS = 86_400_000;

/** Matches the batch cap the deleted backend fetch used, so a peer sees the
 *  same shape of traffic after this change as before it. */
export const MAX_REFRESH_CONCURRENCY = 8;

async function refresh(
  designers: string[],
  force: boolean,
): Promise<{ fetched: string[]; failed: string[] }> {
  const existing = await readAll();
  const targets = force
    ? designers
    : staleDesigners(designers, existing, Date.now(), CATALOG_TTL_MS);

  const fetched: string[] = [];
  const failed: string[] = [];
  const queue = [...targets];

  async function worker(): Promise<void> {
    for (;;) {
      const designer = queue.shift();
      if (designer === undefined) return;
      const result = await fetchCatalog(designer);
      if ("designs" in result) {
        await write({
          designer,
          designs: result.designs,
          fetchedAtMs: Date.now(),
          lastError: null,
        });
        fetched.push(designer);
      } else {
        // A peer that did not answer keeps whatever it last gave us: a stale
        // catalog is more use than an empty one, and the error says so.
        const previous = existing.find((entry) => entry.designer === designer);
        await write({
          designer,
          designs: previous?.designs ?? [],
          fetchedAtMs: previous?.fetchedAtMs ?? 0,
          lastError: result.error,
        });
        failed.push(designer);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_REFRESH_CONCURRENCY, queue.length) },
      worker,
    ),
  );

  if (fetched.length > 0 || failed.length > 0) publishAppStateChange();
  return { fetched, failed };
}

exposeTool(
  "chipswap_market_catalogs",
  {
    title: "Cached catalogs",
    description: "Every peer catalog this machine has fetched.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
  },
  async () => ({ catalogs: (await readAll()) as CachedCatalog[] }),
);

exposeTool(
  "chipswap_market_refresh",
  {
    title: "Refresh catalogs",
    description: "Query peers for their published designs.",
    inputSchema: {
      type: "object",
      required: ["designers"],
      properties: {
        designers: { type: "array", items: { type: "string" } },
        force: { type: "boolean" },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
  },
  async ({ designers, force }) =>
    refresh(designers as string[], force === true),
);

exposeTool(
  "chipswap_market_evict",
  {
    title: "Forget catalogs",
    description: "Drop cached catalogs for designers no longer followed.",
    inputSchema: {
      type: "object",
      required: ["designers"],
      properties: { designers: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
  },
  async ({ designers }) => ({ removed: await evict(designers as string[]) }),
);
```

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: succeeds, and `dist/web/service.js` and `dist/web/service.html` both exist. `freshness.ts` does not exist yet, so this step fails until Task 8 — implement Task 8 first if you prefer a green build here, or accept the failure and let Task 8 close it.

- [ ] **Step 8: Commit**

```bash
git add public/service.html src/resident/ build.ts package.json package-lock.json
git commit -m "feat: resident background that fetches and caches peer catalogs"
```

---

### Task 8: Freshness and cache selection

Pure functions over a fake clock. These carry the TTL rule, so they are tested away from IndexedDB and the network.

**Files:**
- Create: `apps/chipswap/src/resident/freshness.ts`
- Create: `apps/chipswap/test/freshness.test.ts`

**Interfaces:**
- Consumes: `CachedCatalog` (Task 7).
- Produces: `staleDesigners(designers: string[], cached: CachedCatalog[], nowMs: number, ttlMs: number): string[]`. Task 7's `refresh` and Task 9's Market both call it.

- [ ] **Step 1: Write the failing test**

Create `apps/chipswap/test/freshness.test.ts`:

```ts
import { expect, test } from "bun:test";
import { staleDesigners } from "../src/resident/freshness.ts";
import type { CachedCatalog } from "../src/resident/store.ts";

const TTL = 86_400_000;
const NOW = 1_700_000_000_000;

function entry(designer: string, fetchedAtMs: number): CachedCatalog {
  return { designer, designs: [], fetchedAtMs, lastError: null };
}

test("a designer with no cache at all is stale", () => {
  expect(staleDesigners(["alice"], [], NOW, TTL)).toEqual(["alice"]);
});

test("a designer fetched inside the window is left alone", () => {
  const cached = [entry("alice", NOW - TTL + 1)];
  expect(staleDesigners(["alice"], cached, NOW, TTL)).toEqual([]);
});

test("a designer fetched exactly at the window is stale", () => {
  const cached = [entry("alice", NOW - TTL)];
  expect(staleDesigners(["alice"], cached, NOW, TTL)).toEqual(["alice"]);
});

test("a designer whose last attempt failed is stale even inside the window", () => {
  // fetchedAtMs 0 means the entry exists only to carry the error.
  const cached: CachedCatalog[] = [
    { designer: "alice", designs: [], fetchedAtMs: 0, lastError: "unauthorized" },
  ];
  expect(staleDesigners(["alice"], cached, NOW, TTL)).toEqual(["alice"]);
});

test("only the stale members of a mixed set are returned, in input order", () => {
  const cached = [
    entry("alice", NOW - 1_000),
    entry("carol", NOW - TTL - 1),
  ];
  expect(staleDesigners(["alice", "bob", "carol"], cached, NOW, TTL)).toEqual([
    "bob",
    "carol",
  ]);
});

test("a cached designer nobody asked about is not refreshed", () => {
  const cached = [entry("dave", 0)];
  expect(staleDesigners(["alice"], cached, NOW, TTL)).toEqual(["alice"]);
});

test("a clock that jumped backwards does not make a fresh entry stale forever", () => {
  // A future stamp is not stale: it is a clock fault, and refetching on every
  // open would be a loop rather than a correction.
  const cached = [entry("alice", NOW + 60_000)];
  expect(staleDesigners(["alice"], cached, NOW, TTL)).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/freshness.test.ts`
Expected: FAIL — cannot resolve `../src/resident/freshness.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/chipswap/src/resident/freshness.ts`:

```ts
// Which designers are worth asking again.
//
// The TTL is per designer rather than one stamp over the whole cache: adding
// one designer should refetch one designer, and a newly added one should not
// have to wait out somebody else's window to appear.

import type { CachedCatalog } from "./store.ts";

/**
 * The members of `designers` whose cached catalog is missing, older than
 * `ttlMs`, or carrying an error from the last attempt. Input order is kept so
 * the refresh visits the directory in the order the caller listed it.
 */
export function staleDesigners(
  designers: string[],
  cached: CachedCatalog[],
  nowMs: number,
  ttlMs: number,
): string[] {
  const byDesigner = new Map(cached.map((entry) => [entry.designer, entry]));
  return designers.filter((designer) => {
    const entry = byDesigner.get(designer);
    if (entry === undefined) return true;
    // An entry that only ever failed has nothing to go stale; ask again.
    if (entry.lastError !== null) return true;
    if (entry.fetchedAtMs === 0) return true;
    // A stamp in the future is a clock fault, not freshness to distrust.
    return nowMs - entry.fetchedAtMs >= ttlMs;
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/freshness.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: succeeds now that `freshness.ts` exists.

- [ ] **Step 6: Commit**

```bash
git add src/resident/freshness.ts test/freshness.test.ts
git commit -m "feat: per-designer catalog freshness rule"
```

---

### Task 9: Market view over the cache

**Files:**
- Create: `apps/chipswap/src/market_page.ts`
- Create: `apps/chipswap/test/market_page.test.ts`
- Create: `apps/chipswap/src/catalog_client.ts`
- Modify: `apps/chipswap/src/market_filter.ts`
- Modify: `apps/chipswap/src/views/market.tsx`
- Modify: `apps/chipswap/src/api.ts`
- Modify: `apps/chipswap/test/market_filter.test.ts`
- Modify: `apps/chipswap/test/filters_disclosure.test.ts`

**Interfaces:**
- Consumes: `PeerDesign` (Task 2); `staleDesigners` (Task 8); `callTool` from `neutron-tools/app`; `loadDirectory`, `loadCollection`, `loadDesigns` from `./api.ts`.
- Produces:
  - `src/market_page.ts`: `type MarketRow = { designer: string; designId: number; title: string; art: Art; requirements: TradeRequirements; nsfw: boolean; designRevision: string; owned: boolean; fetchedAtMs: number; contactName: string | null }`; `buildMarketPage(input, filter, offset, limit): { rows: MarketRow[]; total: number; nsfwHidden: number }`.
  - `src/catalog_client.ts`: `loadCachedCatalogs()`, `refreshCatalogs(designers, force)`, `evictCatalogs(designers)`.
  - `src/market_filter.ts`: `serializeFilter` is replaced by `matchesFilter(row, filter, context)`.

- [ ] **Step 1: Write the failing test**

Create `apps/chipswap/test/market_page.test.ts`:

```ts
import { expect, test } from "bun:test";
import { buildMarketPage, type MarketInput } from "../src/market_page.ts";
import { defaultFilter } from "../src/market_filter.ts";
import { PIXEL_COUNT } from "../src/chip.ts";
import type { PeerDesign } from "../src/wire.ts";

const art = {
  shapeId: "circle31",
  palette: ["#000000", "#ffffff"],
  pixels: "00".repeat(PIXEL_COUNT),
};

function design(designId: number, title: string, extra: Partial<PeerDesign> = {}): PeerDesign {
  return {
    designId,
    title,
    art,
    requirements: { approval: false, minColors: null, maxCoverage: null, nsfw: "any" },
    nsfw: false,
    designRevision: "1",
    publishedAtNs: "1000",
    ...extra,
  };
}

function input(overrides: Partial<MarketInput> = {}): MarketInput {
  return {
    catalogs: [
      { designer: "aaaaa-aa", designs: [design(1, "Alpha")], fetchedAtMs: 500, lastError: null },
      { designer: "bbbbb-bb", designs: [design(2, "Beta")], fetchedAtMs: 900, lastError: null },
    ],
    directory: [
      { canister: "aaaaa-aa", ignored: false, retired: false, contactName: "Alice" },
      { canister: "bbbbb-bb", ignored: false, retired: false, contactName: null },
    ],
    ownedKeys: new Set<string>(),
    holdings: [],
    ownDesigns: [],
    ...overrides,
  };
}

test("every non-ignored designer's designs appear once", () => {
  const page = buildMarketPage(input(), defaultFilter(), 0, 24);
  expect(page.total).toBe(2);
  expect(page.rows.map((row) => row.title)).toEqual(["Beta", "Alpha"]);
});

test("an ignored or retired designer contributes nothing", () => {
  const page = buildMarketPage(
    input({
      directory: [
        { canister: "aaaaa-aa", ignored: true, retired: false, contactName: "Alice" },
        { canister: "bbbbb-bb", ignored: false, retired: true, contactName: null },
      ],
    }),
    defaultFilter(),
    0,
    24,
  );
  expect(page.total).toBe(0);
});

test("a cached designer no longer in the directory contributes nothing", () => {
  const page = buildMarketPage(input({ directory: [] }), defaultFilter(), 0, 24);
  expect(page.total).toBe(0);
});

test("the contact name rides along from the directory", () => {
  const page = buildMarketPage(input(), defaultFilter(), 0, 24);
  const alpha = page.rows.find((row) => row.title === "Alpha");
  expect(alpha?.contactName).toBe("Alice");
});

test("owned chips are hidden by default and counted when shown", () => {
  const owned = new Set(["aaaaa-aa/1"]);
  const hidden = buildMarketPage(input({ ownedKeys: owned }), defaultFilter(), 0, 24);
  expect(hidden.total).toBe(1);

  const shown = buildMarketPage(
    input({ ownedKeys: owned }),
    { ...defaultFilter(), hideOwned: false },
    0,
    24,
  );
  expect(shown.total).toBe(2);
  expect(shown.rows.find((row) => row.title === "Alpha")?.owned).toBe(true);
});

test("tagged designs are withheld and tallied rather than dropped silently", () => {
  const tagged = input({
    catalogs: [
      {
        designer: "aaaaa-aa",
        designs: [design(1, "Alpha", { nsfw: true }), design(3, "Gamma")],
        fetchedAtMs: 500,
        lastError: null,
      },
    ],
    directory: [{ canister: "aaaaa-aa", ignored: false, retired: false, contactName: null }],
  });
  const page = buildMarketPage(tagged, defaultFilter(), 0, 24);
  expect(page.total).toBe(1);
  expect(page.nsfwHidden).toBe(1);

  const shown = buildMarketPage(tagged, { ...defaultFilter(), showNsfw: true }, 0, 24);
  expect(shown.total).toBe(2);
  expect(shown.nsfwHidden).toBe(0);
});

test("search matches the title and the designer, case-insensitively", () => {
  const page = buildMarketPage(input(), { ...defaultFilter(), search: "alph" }, 0, 24);
  expect(page.rows.map((row) => row.title)).toEqual(["Alpha"]);
});

test("the designer filter narrows to one principal", () => {
  const page = buildMarketPage(
    input(),
    { ...defaultFilter(), designer: "bbbbb-bb" },
    0,
    24,
  );
  expect(page.rows.map((row) => row.title)).toEqual(["Beta"]);
});

test("sorting by title is independent of fetch order", () => {
  const page = buildMarketPage(input(), { ...defaultFilter(), sort: "title" }, 0, 24);
  expect(page.rows.map((row) => row.title)).toEqual(["Alpha", "Beta"]);
});

test("total counts the filtered set, not the cache, so paging stays honest", () => {
  const many = input({
    catalogs: [
      {
        designer: "aaaaa-aa",
        designs: Array.from({ length: 5 }, (_, i) => design(i + 1, `Chip ${i + 1}`)),
        fetchedAtMs: 500,
        lastError: null,
      },
    ],
    directory: [{ canister: "aaaaa-aa", ignored: false, retired: false, contactName: null }],
  });
  const page = buildMarketPage(many, { ...defaultFilter(), sort: "title" }, 2, 2);
  expect(page.total).toBe(5);
  expect(page.rows.map((row) => row.title)).toEqual(["Chip 3", "Chip 4"]);
});

test("an offset past the end yields no rows but keeps the true total", () => {
  const page = buildMarketPage(input(), defaultFilter(), 99, 24);
  expect(page.rows).toEqual([]);
  expect(page.total).toBe(2);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/market_page.test.ts`
Expected: FAIL — cannot resolve `../src/market_page.ts`.

- [ ] **Step 3: Write `src/market_page.ts`**

Create `apps/chipswap/src/market_page.ts`:

```ts
// The market page, assembled in the tile.
//
// The backend used to do this over a stored catalog cache. It does not store
// one any more, so the join happens here instead: cached catalogs from this
// machine, the directory and holdings from the canister, and the filter from
// the reader. `total` counts the filtered set rather than the cache, because
// paging over a number that does not match what was filtered is how a page
// control starts lying about how much is left.

import type { Art, Chip, Design } from "./api.ts";
import type { CachedCatalog } from "./resident/store.ts";
import type { MarketFilter, RequirementFacet } from "./market_filter.ts";
import {
  check,
  measure,
  type Metrics,
  type TradeRequirements,
} from "./requirements.ts";
import { decodePixels } from "./chip.ts";

/** Only the directory fields the market actually reads. */
export type MarketDirectoryEntry = {
  canister: string;
  ignored: boolean;
  retired: boolean;
  contactName: string | null;
};

export type MarketInput = {
  catalogs: CachedCatalog[];
  directory: MarketDirectoryEntry[];
  /** `designer/designId` for every design already in the collection. */
  ownedKeys: Set<string>;
  holdings: Chip[];
  ownDesigns: Design[];
};

export type MarketRow = {
  designer: string;
  designId: number;
  title: string;
  art: Art;
  requirements: TradeRequirements;
  nsfw: boolean;
  designRevision: string;
  owned: boolean;
  fetchedAtMs: number;
  contactName: string | null;
};

export function ownedKey(designer: string, designId: number): string {
  return `${designer}/${designId}`;
}

/** What we could put up in a trade, measured once rather than per row. */
type Offer = { metrics: Metrics; nsfw: boolean };

function offersOf(input: MarketInput): Offer[] {
  return [
    ...input.holdings.map((chip) => ({
      metrics: measure(decodePixels(chip.art.pixels), chip.art.palette),
      nsfw: chip.nsfw,
    })),
    // A draft cannot be offered: minting spends a published slot's design.
    ...input.ownDesigns
      .filter((design) => design.state === "published")
      .map((design) => ({
        metrics: measure(decodePixels(design.art.pixels), design.art.palette),
        nsfw: design.nsfw,
      })),
  ];
}

/** Whether anything we could offer satisfies this design's requirements. */
function tradeable(row: MarketRow, offers: Offer[]): boolean {
  return offers.some(
    (offer) => check(row.requirements, offer.metrics, offer.nsfw) === null,
  );
}

function matchesFacet(
  facet: RequirementFacet,
  row: MarketRow,
  offers: Offer[],
): boolean {
  const { approval, minColors, maxCoverage, nsfw } = row.requirements;
  switch (facet) {
    case "tradeable":
      return tradeable(row, offers);
    case "open":
      return (
        !approval && minColors === null && maxCoverage === null && nsfw === "any"
      );
    case "approval":
      return approval;
    case "min_colors":
      return minColors !== null;
    case "max_coverage":
      return maxCoverage !== null;
    case "tag_rule":
      return nsfw !== "any";
  }
}

function compareBigint(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ties break on designer then id so two equal rows never swap on re-render. */
function tiebreak(left: MarketRow, right: MarketRow): number {
  const byDesigner = left.designer.localeCompare(right.designer);
  return byDesigner !== 0 ? byDesigner : left.designId - right.designId;
}

function sorted(rows: MarketRow[], sort: MarketFilter["sort"]): MarketRow[] {
  const ranked = [...rows];
  switch (sort) {
    case "recent":
      ranked.sort(
        (a, b) => b.fetchedAtMs - a.fetchedAtMs || tiebreak(a, b),
      );
      break;
    case "oldest":
      ranked.sort(
        (a, b) => a.fetchedAtMs - b.fetchedAtMs || tiebreak(a, b),
      );
      break;
    case "title":
      ranked.sort((a, b) => a.title.localeCompare(b.title) || tiebreak(a, b));
      break;
    case "designer":
      ranked.sort(tiebreak);
      break;
  }
  return ranked;
}

export function buildMarketPage(
  input: MarketInput,
  filter: MarketFilter,
  offset: number,
  limit: number,
): { rows: MarketRow[]; total: number; nsfwHidden: number } {
  const followed = new Map(
    input.directory
      .filter((entry) => !entry.ignored && !entry.retired)
      .map((entry) => [entry.canister, entry]),
  );

  // A cached designer the owner has since dropped contributes nothing. The
  // cache is evicted on removal too; this is the belt to that braces.
  const all: MarketRow[] = [];
  for (const catalog of input.catalogs) {
    const entry = followed.get(catalog.designer);
    if (entry === undefined) continue;
    for (const design of catalog.designs) {
      all.push({
        designer: catalog.designer,
        designId: design.designId,
        title: design.title,
        art: design.art,
        requirements: design.requirements,
        nsfw: design.nsfw,
        designRevision: design.designRevision,
        owned: input.ownedKeys.has(ownedKey(catalog.designer, design.designId)),
        fetchedAtMs: catalog.fetchedAtMs,
        contactName: entry.contactName,
      });
    }
  }

  const offers = offersOf(input);
  const search = filter.search.trim().toLowerCase();
  const narrowed = all.filter((row) => {
    if (filter.designer !== null && row.designer !== filter.designer) {
      return false;
    }
    if (
      search !== "" &&
      !row.title.toLowerCase().includes(search) &&
      !row.designer.toLowerCase().includes(search) &&
      !(row.contactName ?? "").toLowerCase().includes(search)
    ) {
      return false;
    }
    // Facets widen each other: ticking two asks for either.
    if (
      filter.requirements.length > 0 &&
      !filter.requirements.some((facet) => matchesFacet(facet, row, offers))
    ) {
      return false;
    }
    if (filter.hideOwned && row.owned) return false;
    return true;
  });

  // The tag axis is applied last so the tally counts only rows that survived
  // every other filter. Counting earlier would report chips the reader had
  // already excluded for some other reason.
  const nsfwHidden = filter.showNsfw
    ? 0
    : narrowed.filter((row) => row.nsfw).length;
  const visible = filter.showNsfw
    ? narrowed
    : narrowed.filter((row) => !row.nsfw);

  const ranked = sorted(visible, filter.sort);
  return {
    rows: ranked.slice(offset, offset + limit),
    total: ranked.length,
    nsfwHidden,
  };
}
```

`check(requirements, offered: Metrics, offeredNsfw: boolean)` is the verified signature in `src/requirements.ts:91`, and `measure(pixels, palette)` builds the `Metrics`. Offers are measured once per page rather than once per row: a forty-chip collection against a hundred market rows would otherwise re-measure 757 pixels four thousand times for one render.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test test/market_page.test.ts`
Expected: PASS, all eleven cases.

- [ ] **Step 5: Replace `serializeFilter` with `matchesFilter`**

In `src/market_filter.ts`, delete `serializeFilter` and add the predicate `buildMarketPage` calls. Update the `MAX_SEARCH_CHARS` doc comment: it no longer mirrors `backend/Directory.mo`, which has no search. Replace that paragraph with:

```ts
/**
 * The longest search the Market accepts. Filtering happens in the tile now, so
 * this is a UI choice rather than a backend limit: a very long search says
 * nothing a short one does not, and the input should say so before it is typed.
 */
```

Update `test/market_filter.test.ts` and `test/filters_disclosure.test.ts` to exercise `matchesFilter` instead of `serializeFilter`. Keep every existing assertion about `filterLabel`, `defaultFilter`, `isDefaultFilter`, `toggleFacet`, and the canonical facet order — none of those change.

- [ ] **Step 6: Write the tool client**

Create `apps/chipswap/src/catalog_client.ts`:

```ts
// The tile's side of the background's three tools.
//
// A same-app tool call needs no owner dialog, so the Market can reach the
// cache as freely as it reaches the backend. Everything crossing this boundary
// is parsed rather than trusted: the background is our own code, but it is
// still another process, and a shape that changed underneath us should fail
// here rather than halfway through a render.

import { callTool, loadTileContext } from "neutron-tools/app";
import type { CachedCatalog } from "./resident/store.ts";
import type { PeerDesign } from "./wire.ts";

function backendTarget(): string {
  const app = loadTileContext().app;
  if (app === null) throw new Error("The tile has no app context");
  return `app:${app}:background`;
}

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await callTool({
    target: backendTarget(),
    name,
    arguments: args,
  });
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`The catalog service returned no ${name} result`);
  }
  return result as Record<string, unknown>;
}

function isDesign(value: unknown): value is PeerDesign {
  if (typeof value !== "object" || value === null) return false;
  const design = value as Record<string, unknown>;
  return (
    typeof design.designId === "number" &&
    typeof design.title === "string" &&
    typeof design.designRevision === "string" &&
    typeof design.art === "object" &&
    design.art !== null
  );
}

function parseCatalog(value: unknown): CachedCatalog {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid cached catalog");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.designer !== "string") throw new Error("Invalid designer");
  if (!Array.isArray(entry.designs)) throw new Error("Invalid catalog designs");
  return {
    designer: entry.designer,
    designs: entry.designs.filter(isDesign),
    fetchedAtMs:
      typeof entry.fetchedAtMs === "number" ? entry.fetchedAtMs : 0,
    lastError: typeof entry.lastError === "string" ? entry.lastError : null,
  };
}

export async function loadCachedCatalogs(): Promise<CachedCatalog[]> {
  const result = await call("chipswap_market_catalogs", {});
  const catalogs = result.catalogs;
  if (!Array.isArray(catalogs)) throw new Error("Invalid catalog list");
  return catalogs.map(parseCatalog);
}

export async function refreshCatalogs(
  designers: string[],
  force: boolean,
): Promise<{ fetched: string[]; failed: string[] }> {
  const result = await call("chipswap_market_refresh", { designers, force });
  const text = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((e): e is string => typeof e === "string") : [];
  return { fetched: text(result.fetched), failed: text(result.failed) };
}

export async function evictCatalogs(designers: string[]): Promise<number> {
  const result = await call("chipswap_market_evict", { designers });
  return typeof result.removed === "number" ? result.removed : 0;
}
```

- [ ] **Step 7: Rewrite the Market view**

In `src/views/market.tsx`:

1. Replace the `loadStore` call with a load that runs `loadCachedCatalogs`, `loadDirectory(0, DIRECTORY_PAGE)`, `loadCollection(0, 100)`, and `loadDesigns()` together, then calls `buildMarketPage`.
2. After first paint, compute the refresh set with `staleDesigners` over the non-ignored, non-retired directory and call `refreshCatalogs(set, false)`; re-run the load when it resolves.
3. Point the existing `data-tid="chipswap-refresh-catalogs"` control at `refreshCatalogs(everyEligibleDesigner, true)`.
4. Keep the existing empty-state copy but adjust it to name the new flow: `"Nothing here yet. Add designers in the Directory, then refresh catalogs to see what they have published."` already reads correctly and needs no change.
5. Delete `BATCH` and the eight-at-a-time loop — the background owns concurrency now.

In `src/api.ts`, delete `loadStore`, `parseStoreRow`, the `StoreRow` type, and `catalogDesigners` from `Status` and `parseStatus`.

- [ ] **Step 8: Run the TS suite and build**

Run: `bun test && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 9: Commit**

```bash
git add src/ test/
git commit -m "feat: build the market page in the tile from the cached catalogs"
```

---

### Task 10: Directory view over the cache

**Files:**
- Modify: `apps/chipswap/src/views/directory.tsx`
- Modify: `apps/chipswap/src/index.tsx`
- Modify: `apps/chipswap/test/chip_card.test.tsx` (only if it asserts on removed fields)

**Interfaces:**
- Consumes: `loadCachedCatalogs`, `evictCatalogs` (Task 9); `DirectoryEntry` from `./api.ts` (now without `designCount` and `lastCatalogNs`).
- Produces: no new exports.

- [ ] **Step 1: Drop the removed fields from the API layer**

In `src/api.ts`, remove `designCount` and `lastCatalogNs` from the `DirectoryEntry` type and from `parseDirectoryEntry`.

- [ ] **Step 2: Re-source the columns from the cache**

In `src/views/directory.tsx`, load cached catalogs alongside the directory. For each entry:

- design count is the cached entry's `designs.length`;
- last fetched is its `fetchedAtMs`, rendered with a millisecond formatter rather than `formatTimestamp`, which takes nanoseconds;
- a designer with no cache entry renders `"not fetched"` in both columns.

A zero would be a false statement where the truth is that this machine has not asked yet, so the absent case gets its own words rather than a number.

Where the entry has a `lastError`, render `"didn't answer"` with the error as a title attribute. This is the rollout signal from the spec §10.3 — a peer still on `caller: "canister"` shows up here rather than silently vanishing from the Market.

- [ ] **Step 3: Evict on removal, ignore, and retire**

In the same view, after a successful `removeDirectoryEntry`, `setDirectoryIgnored(true)`, or `setDirectoryRetired(true)`, call `evictCatalogs([canister])`. A designer the owner has stopped following should not leave their catalog on disk.

- [ ] **Step 4: Drop the status field from the header**

In `src/index.tsx`, nothing references `catalogDesigners` today, so no change is needed there. Confirm with:

Run: `grep -rn "catalogDesigners\|designCount\|lastCatalogNs\|loadStore\|fetchCatalogs\|StoreRow" src/ test/`
Expected: no matches.

- [ ] **Step 5: Run the TS suite and build**

Run: `bun test && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 6: Commit**

```bash
git add src/ test/
git commit -m "feat: directory reads design counts from the machine's own cache"
```

---

### Task 11: Package, validate, and close out

**Files:**
- Modify: `apps/chipswap/test/package.test.ts`
- Modify: `apps/chipswap/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a packaged `chipswap.v0.1.16.neutron`.

- [ ] **Step 1: Assert the built package carries the background**

In `apps/chipswap/test/package.test.ts`, add:

```ts
const serviceHtmlUrl = new URL("../dist/web/service.html", import.meta.url);
const serviceJsUrl = new URL("../dist/web/service.js", import.meta.url);

test("the background ships with a policy that reaches the IC and nothing else", async () => {
  const html = await readFile(serviceHtmlUrl, "utf8");

  // The background needs the gateway; it needs nothing else, and saying so in
  // the document is what keeps a bundled dependency from reaching further.
  expect(html).toContain("connect-src 'self' https://*.icp0.io");
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("./service.js");
  // A wildcard host or an inline script would defeat the point.
  expect(html).not.toMatch(/connect-src[^;]*\s\*/u);
  expect(html).not.toContain("'unsafe-inline'");

  const js = await readFile(serviceJsUrl, "utf8");
  expect(js.length).toBeGreaterThan(0);
});

test("the tile bundle carries no peer network code", async () => {
  // The fetching lives in the background, which is the only surface with
  // persistence. A tile that also reached the gateway would be a second,
  // cacheless path to the same data.
  const js = await readFile(jsUrl, "utf8");
  expect(js).not.toContain("icp0.io");
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS — packaging, `bun test`, and the Motoko suite.

- [ ] **Step 3: Package**

Run: `npm run package`
Expected: produces `chipswap.v0.1.16.neutron` without error.

- [ ] **Step 4: Update the README**

In `apps/chipswap/README.md`, update the architecture section to say that peer catalogs are fetched by the browser and cached per machine with a one-day TTL, that the canister no longer stores other designers' catalogs, and that the `catalog` route is readable by any caller. Remove any mention of `chipswap_store` and `chipswap_fetch_catalogs`.

- [ ] **Step 5: Commit**

```bash
git add test/package.test.ts README.md chipswap.v0.1.16.neutron
git commit -m "chore: package chipswap v0.1.16 with client-fetched catalogs"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §3 route policy | 6 |
| §4.1 methods removed | 4 |
| §4.2 Directory module | 4 |
| §4.3 memory v6 | 3 |
| §5.1 envelopes | 7 (`agent.ts`) |
| §5.2 `src/wire.ts` | 1, 2 |
| §5.3 agent | 7 |
| §6.1 declaration | 6, 7 |
| §6.2 store | 7 |
| §6.3 exposed tools | 7 |
| §7 staleness | 8, 9 |
| §8 trust | 7 (comment), 5 (the guard that makes it safe) |
| §9 propose verification | 5 |
| §10.1 Market view | 9 |
| §10.2 Directory view | 10 |
| §10.3 degraded peers | 10 |
| §11 testing | 1, 2, 3, 8, 9, 11 |
| §12 manifest | 3, 4, 6 |

**Notes on two ordering hazards:**

- Task 7 Step 7 will not build until Task 8 exists, because `service.ts` imports `freshness.ts`. This is called out inline. An executor running strictly in order should implement Task 8 before running Task 7's build step.
- Task 6's `service.html` package assertions depend on Task 7. Task 6 Step 4 says to move that one assertion forward if the suite blocks.
