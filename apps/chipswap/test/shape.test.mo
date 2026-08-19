import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Shape "../backend/Shape";

// The row table in Planning/chipswap.md is authoritative: 31 rows, 757 pixels.
assert (Shape.ROW_WIDTHS.size() == 31);
assert (Shape.DIAMETER == 31);
assert (Shape.PIXEL_COUNT == 757);
assert (Shape.SHAPE_ID == "circle31");
assert (Shape.MAX_PALETTE == 64);

var total = 0;
for (width in Shape.ROW_WIDTHS.values()) total += width;
assert (total == Shape.PIXEL_COUNT);
assert (Shape.ROW_WIDTHS[0] == 9);
assert (Shape.ROW_WIDTHS[1] == 13);
assert (Shape.ROW_WIDTHS[15] == 31);
assert (Shape.ROW_WIDTHS[30] == 9);

let offsets = Shape.rowOffsets();
assert (offsets.size() == 31);
// The literal offset table must stay the running sum of the row widths.
var running = 0;
for (row in offsets.keys()) {
    assert (offsets[row] == running);
    running += Shape.ROW_WIDTHS[row];
};
assert (running == Shape.PIXEL_COUNT);
assert (offsets[0] == 0);
assert (offsets[1] == 9);
assert (offsets[2] == 22);
assert (offsets[30] == 748);

assert (Shape.indexOf(0, 0) == ?0);
assert (Shape.indexOf(0, 8) == ?8);
assert (Shape.indexOf(0, 9) == null);
assert (Shape.indexOf(1, 0) == ?9);
assert (Shape.indexOf(31, 0) == null);
assert (Shape.indexOf(30, 8) == ?756);

// Chip-local column coordinates are centred: row 0 spans columns 11..19.
assert (Shape.indexAt(11, 0) == ?0);
assert (Shape.indexAt(19, 0) == ?8);
assert (Shape.indexAt(10, 0) == null);
assert (Shape.indexAt(20, 0) == null);
assert (Shape.indexAt(0, 15) == ?363);
assert (Shape.indexAt(31, 15) == null);

let descriptor = Shape.descriptor();
assert (descriptor.shape_id == "circle31");
assert (descriptor.diameter == 31);
assert (descriptor.pixel_count == 757);
assert (descriptor.row_widths.size() == 31);

func pixels(size : Nat, mutate : Nat -> Nat8) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(size, mutate));
};

let flat = pixels(757, func(_) { 0 });
assert (Shape.validateArt("circle31", 1, flat) == null);
assert (Shape.validateArt("circle31", 64, flat) == null);
assert (Shape.validateArt("square9", 1, flat) == ?"shape_unsupported");
assert (Shape.validateArt("circle31", 0, flat) == ?"palette_empty");
assert (Shape.validateArt("circle31", 65, flat) == ?"palette_limit");
assert (Shape.validateArt("circle31", 1, pixels(756, func(_) { 0 })) == ?"pixel_count");
assert (Shape.validateArt("circle31", 1, pixels(758, func(_) { 0 })) == ?"pixel_count");
assert (
    Shape.validateArt(
        "circle31",
        2,
        pixels(757, func(i) { if (i == 5) 3 else 0 }),
    ) == ?"palette_index"
);
assert (
    Shape.validateArt(
        "circle31",
        4,
        pixels(757, func(i) { Nat8.fromNat(i % 4) }),
    ) == null
);
