import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Debug "mo:core/Debug";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Shape "../backend/Shape";
import Wire "../backend/Wire";

// Emits the catalog-wire fixtures both decoder test suites read.
//
// The Motoko encoder is the format's source of truth, so every valid case is
// produced by it rather than hand-written. The refusals are mutations of a
// valid message at offsets derived from the field layout below, not magic
// numbers: a message the encoder cannot produce is exactly what a decoder has
// to refuse, and deriving the offsets keeps the mutation aimed at the field it
// claims to be aiming at.
//
// Run through scripts/gen_wire_fixtures.ts, which compiles this to WASI,
// captures the output, and writes test/fixtures/catalog_wire.{json,mo}.

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

let openRequirements : Wire.Requirements = {
    approval = false;
    min_colors = null;
    max_coverage = null;
    nsfw = null;
};

// "Open Water" is ten ASCII bytes; the offset table below depends on that.
let OPEN_TITLE = "Open Water";
let OPEN_TITLE_BYTES : Nat = 10;
let OPEN_PALETTE : Nat = 3;

let openDesign : Wire.Design = {
    design_id = 1;
    title = OPEN_TITLE;
    art = art(OPEN_PALETTE);
    requirements = openRequirements;
    nsfw = false;
    design_revision = 4;
    published_at_ns = 1_600_000_000_000_000_000;
};

let strictDesign : Wire.Design = {
    design_id = 9;
    // One two-byte and one three-byte character, so a decoder that reads UTF-8
    // as bytes shows up as a wrong title rather than passing quietly.
    title = "Sunrise \u{e9}\u{4e2d}";
    art = art(8);
    requirements = {
        approval = true;
        min_colors = ?6;
        max_coverage = ?40;
        nsfw = ? #disallowed;
    };
    nsfw = true;
    // The largest u64 there is: it does not fit a JS number, which is the
    // whole reason the TypeScript decoder carries it as text.
    design_revision = 18_446_744_073_709_551_615;
    published_at_ns = 1_700_000_000_000_000_000;
};

let requiredTag : Wire.Design = {
    design_id = 2;
    title = "Tagged";
    art = art(4);
    requirements = {
        approval = false;
        min_colors = null;
        max_coverage = null;
        nsfw = ? #required;
    };
    nsfw = true;
    design_revision = 2;
    published_at_ns = 1_650_000_000_000_000_000;
};

func encodeOne(design : Wire.Design) : Blob {
    Wire.encodeCatalogReply({ designs = [design] });
};

let oneDesign = encodeOne(openDesign);

// --- Offsets into `oneDesign`, derived rather than counted ----------------

let HEADER : Nat = 6; // 4 magic + type + version
let COUNT_AT : Nat = HEADER; // u16 design count
let DESIGN_AT : Nat = COUNT_AT + 2;
let TITLE_LEN_AT : Nat = DESIGN_AT + 2; // after the u16 design id
let TITLE_AT : Nat = TITLE_LEN_AT + 2;
let SHAPE_LEN_AT : Nat = TITLE_AT + OPEN_TITLE_BYTES;
let SHAPE_AT : Nat = SHAPE_LEN_AT + 2;
let PALETTE_COUNT_AT : Nat = SHAPE_AT + 8; // "circle31"
let PALETTE_AT : Nat = PALETTE_COUNT_AT + 2;
let PIXELS_LEN_AT : Nat = PALETTE_AT + OPEN_PALETTE * 4;
let PIXELS_AT : Nat = PIXELS_LEN_AT + 2;
let FLAGS_AT : Nat = PIXELS_AT + Shape.PIXEL_COUNT;

func mutate(blob : Blob, index : Nat, value : Nat8) : Blob {
    let raw = Blob.toArray(blob);
    Blob.fromArray(
        Array.tabulate<Nat8>(
            raw.size(),
            func(i) { if (i == index) value else raw[i] },
        )
    );
};

func truncate(blob : Blob, keep : Nat) : Blob {
    let raw = Blob.toArray(blob);
    Blob.fromArray(Array.tabulate<Nat8>(keep, func(i) { raw[i] }));
};

func append(blob : Blob, extra : [Nat8]) : Blob {
    let raw = Blob.toArray(blob);
    Blob.fromArray(
        Array.tabulate<Nat8>(
            raw.size() + extra.size(),
            func(i) { if (i < raw.size()) raw[i] else extra[i - raw.size()] },
        )
    );
};

let valid : [(Text, Blob)] = [
    ("empty", Wire.encodeCatalogReply({ designs = [] })),
    ("open_single", oneDesign),
    ("strict_single", encodeOne(strictDesign)),
    ("required_tag", encodeOne(requiredTag)),
    (
        "three",
        Wire.encodeCatalogReply({
            designs = [openDesign, strictDesign, requiredTag];
        }),
    ),
    (
        "full_ten",
        Wire.encodeCatalogReply({
            designs = Array.tabulate<Wire.Design>(
                10,
                func(i) {
                    {
                        design_id = i;
                        title = OPEN_TITLE;
                        art = art(OPEN_PALETTE);
                        requirements = openRequirements;
                        nsfw = false;
                        design_revision = 4;
                        published_at_ns = 1_600_000_000_000_000_000;
                    };
                },
            );
        }),
    ),
];

let invalid : [(Text, Blob)] = [
    // A message that is not ours at all.
    ("bad_magic", mutate(oneDesign, 0, 0x44)),
    // Type 5 is the directory message, not a catalog.
    ("wrong_type", mutate(oneDesign, 4, 5)),
    // Version 2 is the previous layout; refusing it is what the byte is for.
    ("old_version", mutate(oneDesign, 5, 2)),
    // Eleven designs, one past the ten a catalog may hold.
    ("count_over_max", mutate(oneDesign, COUNT_AT + 1, 11)),
    // A complete message with one byte after it: two byte strings must never
    // mean the same message.
    ("trailing_byte", append(oneDesign, [0])),
    // Claims one design and carries none.
    ("truncated", truncate(oneDesign, HEADER + 2)),
    // Shorter than a header.
    ("too_short", Blob.fromArray([0x43, 0x53, 0x57])),
    // A palette no chip can be drawn from.
    ("palette_empty", mutate(oneDesign, PALETTE_COUNT_AT + 1, 0)),
    // A pixel pointing past the palette it indexes.
    ("pixel_index_over_palette", mutate(oneDesign, PIXELS_AT, Nat8.fromNat(OPEN_PALETTE))),
    // A title that is not UTF-8.
    ("bad_utf8_title", mutate(oneDesign, TITLE_AT, 0xff)),
    // A requirement flag from a future we cannot read.
    ("flags_unknown_bit", mutate(oneDesign, FLAGS_AT, 32)),
    // The `required` bit alone would be a second spelling of "no rule".
    ("nsfw_required_without_rule", mutate(oneDesign, FLAGS_AT, 16)),
];

func jsonSection(section : Text, entries : [(Text, Blob)]) {
    Debug.print("  \"" # section # "\": {");
    var index = 0;
    while (index < entries.size()) {
        let (name, blob) = entries[index];
        let comma = if (index + 1 < entries.size()) "," else "";
        Debug.print("    \"" # name # "\": \"" # hex(blob) # "\"" # comma);
        index += 1;
    };
};

Debug.print("{");
jsonSection("valid", valid);
Debug.print("  },");
jsonSection("invalid", invalid);
Debug.print("  }");
Debug.print("}");

Debug.print("---MOTOKO---");

func motokoSection(section : Text, entries : [(Text, Blob)]) {
    Debug.print("    public let " # section # " : [(Text, Text)] = [");
    var index = 0;
    while (index < entries.size()) {
        let (name, blob) = entries[index];
        let comma = if (index + 1 < entries.size()) "," else "";
        Debug.print("        (\"" # name # "\", \"" # hex(blob) # "\")" # comma);
        index += 1;
    };
    Debug.print("    ];");
};

Debug.print("// Generated by scripts/gen_wire_fixtures.mo. Do not edit by hand.");
Debug.print("//");
Debug.print("// The Motoko mirror of test/fixtures/catalog_wire.json. Both files come from");
Debug.print("// one generator so the two decoder suites cannot drift onto different bytes.");
Debug.print("import Char \"mo:core/Char\";");
Debug.print("import List \"mo:core/List\";");
Debug.print("import Nat8 \"mo:core/Nat8\";");
Debug.print("import Nat32 \"mo:core/Nat32\";");
Debug.print("import Text \"mo:core/Text\";");
Debug.print("");
Debug.print("module {");
motokoSection("valid", valid);
Debug.print("");
motokoSection("invalid", invalid);
Debug.print("");
Debug.print("    func digit(character : Char) : ?Nat8 {");
Debug.print("        let point = Char.toNat32(character);");
Debug.print("        if (point >= 48 and point <= 57) return ?Nat8.fromNat(Nat32.toNat(point - 48));");
Debug.print("        if (point >= 97 and point <= 102) return ?Nat8.fromNat(Nat32.toNat(point - 87));");
Debug.print("        null;");
Debug.print("    };");
Debug.print("");
Debug.print("    public func unhex(value : Text) : ?[Nat8] {");
Debug.print("        let characters = Text.toArray(value);");
Debug.print("        if (characters.size() % 2 != 0) return null;");
Debug.print("        let out = List.empty<Nat8>();");
Debug.print("        var index = 0;");
Debug.print("        while (index < characters.size()) {");
Debug.print("            let ?high = digit(characters[index]) else return null;");
Debug.print("            let ?low = digit(characters[index + 1]) else return null;");
Debug.print("            List.add(out, high * 16 + low);");
Debug.print("            index += 2;");
Debug.print("        };");
Debug.print("        ?List.toArray(out);");
Debug.print("    };");
Debug.print("}");
