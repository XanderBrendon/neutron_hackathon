import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";

// Chip geometry. The row-width table from Planning/chipswap.md is the source of
// truth; it is exactly the raster of a 31px circle sampled at pixel centres.
// Every consumer derives offsets from this data rather than assuming a radius,
// so a future chip shape is a new descriptor rather than a rewrite.
module {
    public let SHAPE_ID : Text = "circle31";
    public let DIAMETER : Nat = 31;
    public let MAX_PALETTE : Nat = 64;

    public let ROW_WIDTHS : [Nat] = [
        9, 13, 17, 19, 21, 23, 25, 27, 27, 29, 29, 31, 31, 31, 31, 31,
        31, 31, 31, 31, 29, 29, 27, 27, 25, 23, 21, 19, 17, 13, 9,
    ];

    public let PIXEL_COUNT : Nat = 757;

    public type Descriptor = {
        shape_id : Text;
        diameter : Nat;
        row_widths : [Nat];
        pixel_count : Nat;
    };

    // Running sum of ROW_WIDTHS. Motoko module bindings must be static, so this
    // is a literal; test/shape.test.mo proves it against the widths.
    let OFFSETS : [Nat] = [
        0, 9, 22, 39, 58, 79, 102, 127, 154, 181, 210, 239, 270, 301, 332,
        363, 394, 425, 456, 487, 518, 547, 576, 603, 630, 655, 678, 699,
        718, 735, 748,
    ];

    public func rowOffsets() : [Nat] = OFFSETS;

    public func descriptor() : Descriptor {
        {
            shape_id = SHAPE_ID;
            diameter = DIAMETER;
            row_widths = ROW_WIDTHS;
            pixel_count = PIXEL_COUNT;
        };
    };

    // Index of the `column`-th mask cell inside `row`.
    public func indexOf(row : Nat, column : Nat) : ?Nat {
        if (row >= ROW_WIDTHS.size()) return null;
        if (column >= ROW_WIDTHS[row]) return null;
        ?(OFFSETS[row] + column);
    };

    // Index for chip-local coordinates, where both axes run 0..DIAMETER-1 and
    // each row is centred inside the square.
    public func indexAt(x : Nat, y : Nat) : ?Nat {
        if (y >= ROW_WIDTHS.size() or x >= DIAMETER) return null;
        let width = ROW_WIDTHS[y];
        let start = (DIAMETER - width) / 2;
        if (x < start or x >= start + width) return null;
        ?(OFFSETS[y] + (x - start));
    };

    // null means the art is valid. Untrusted art is rejected, never clamped.
    public func validateArt(shapeId : Text, paletteSize : Nat, pixels : Blob) : ?Text {
        if (shapeId != SHAPE_ID) return ?"shape_unsupported";
        if (paletteSize == 0) return ?"palette_empty";
        if (paletteSize > MAX_PALETTE) return ?"palette_limit";
        if (pixels.size() != PIXEL_COUNT) return ?"pixel_count";
        for (index in pixels.values()) {
            if (Nat8.toNat(index) >= paletteSize) return ?"palette_index";
        };
        null;
    };
}
