import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Designs "../backend/Designs";
import Memory "../backend/memory/chipswap/v10";
import Requirements "../backend/Requirements";
import Shape "../backend/Shape";

let self = Principal.fromBlob(Blob.fromArray([0, 1, 1]));

func flatPixels(index : Nat8) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(_) { index }));
};

func expectOk<T>(result : Designs.Result<T>) : T {
    switch (result) {
        case (#ok(value)) value;
        case (#err(code)) Runtime.trap("unexpected error: " # code);
    };
};

func expectErr<T>(result : Designs.Result<T>) : Text {
    switch (result) {
        case (#ok(_)) Runtime.trap("expected an error");
        case (#err(code)) code;
    };
};

// A new draft consumes one of the ten slots and starts with usable art.
let mem = Memory.init();
assert (Designs.slotsUsed(mem) == 0);
let firstId = expectOk(Designs.create(mem, "  Sunrise  ", 100));
assert (firstId == 1);
assert (Designs.slotsUsed(mem) == 1);

let ?draft = Designs.get(mem, firstId) else Runtime.trap("draft missing");
assert (draft.title == "Sunrise");
assert (draft.state == #draft);
assert (draft.revision == 1);
assert (draft.next_serial == 1);
assert (draft.art.shape_id == Shape.SHAPE_ID);
assert (draft.art.palette.size() >= 1);
assert (draft.art.pixels.size() == Shape.PIXEL_COUNT);
assert (Shape.validateArt(draft.art.shape_id, draft.art.palette.size(), draft.art.pixels) == null);

// Titles are trimmed and bounded.
assert (expectErr(Designs.create(mem, "   ", 100)) == "title_invalid");
let longTitle = Array.foldLeft<Nat, Text>(
    Array.tabulate<Nat>(49, func(i) { i }),
    "",
    func(accumulator, _) { accumulator # "x" },
);
assert (expectErr(Designs.create(mem, longTitle, 100)) == "title_invalid");
assert (expectErr(Designs.create(mem, "bad\ntitle", 100)) == "title_invalid");

// Ten slots, and only ten.
var created = 1;
while (created < 10) {
    ignore expectOk(Designs.create(mem, "Draft", 100));
    created += 1;
};
assert (Designs.slotsUsed(mem) == 10);
assert (expectErr(Designs.create(mem, "Eleventh", 100)) == "slot_limit");

// Deleting a draft frees its slot, and the freed slot is reused.
assert (expectOk(Designs.delete(mem, 4)) == ());
assert (Designs.slotsUsed(mem) == 9);
assert (expectOk(Designs.create(mem, "Reused", 100)) == 4);
assert (Designs.slotsUsed(mem) == 10);

// Saving bumps the revision and enforces the expected revision.
let palette : [Nat32] = [0x101010, 0xffffff, 0x7fd1c1];
let saved = expectOk(Designs.save(mem, 1, 1, "Sunrise II", palette, flatPixels(2)));
assert (saved == 2);
let ?updated = Designs.get(mem, 1) else Runtime.trap("draft missing");
assert (updated.title == "Sunrise II");
assert (updated.art.palette == palette);
assert (updated.revision == 2);
assert (expectErr(Designs.save(mem, 1, 1, "Stale", palette, flatPixels(0))) == "revision_conflict");
assert (expectErr(Designs.save(mem, 99, 1, "Missing", palette, flatPixels(0))) == "not_found");

// Art validation is shared with Shape.
assert (expectErr(Designs.save(mem, 1, 2, "Empty palette", [], flatPixels(0))) == "palette_empty");
let bigPalette = Array.tabulate<Nat32>(65, func(i) { Nat32.fromNat(i) });
assert (expectErr(Designs.save(mem, 1, 2, "Too many", bigPalette, flatPixels(0))) == "palette_limit");
assert (expectErr(Designs.save(mem, 1, 2, "Out of range", palette, flatPixels(5))) == "palette_index");
assert (
    expectErr(
        Designs.save(
            mem,
            1,
            2,
            "Short",
            palette,
            Blob.fromArray(Array.tabulate<Nat8>(756, func(_) { 0 })),
        )
    ) == "pixel_count"
);

// A new draft asks nothing of anyone.
let ?opened = Designs.get(mem, 1) else Runtime.trap("design missing");
assert (Requirements.open(opened.requirements));
assert (not opened.nsfw);

// Publishing freezes the art, sets the policy, and consumes the slot forever.
let strict : Memory.TradeRequirements = {
    approval = true;
    min_colors = ?6;
    max_coverage = ?40;
    nsfw = ? #disallowed;
};
assert (expectOk(Designs.publish(mem, 1, 2, strict, true, 300)) == ());
let ?published = Designs.get(mem, 1) else Runtime.trap("design missing");
assert (published.state == #published);
assert (published.requirements == strict);
assert (published.nsfw);
assert (published.published_at_ns == ?300);
assert (published.revision == 2);
assert (expectErr(Designs.save(mem, 1, 2, "After", palette, flatPixels(0))) == "immutable");
assert (expectErr(Designs.delete(mem, 1)) == "immutable");
assert (
    expectErr(Designs.publish(mem, 1, 2, Memory.openRequirements(), false, 320)) == "immutable"
);
assert (Designs.slotsUsed(mem) == 10);

// A requirement that restricts nothing is refused rather than stored, at
// publication and afterwards alike.
let ?stillDraft = Designs.get(mem, 2) else Runtime.trap("design missing");
assert (stillDraft.state == #draft);
assert (
    expectErr(
        Designs.publish(
            mem,
            2,
            stillDraft.revision,
            { Memory.openRequirements() with min_colors = ?1 },
            false,
            330,
        )
    ) == "requirements_invalid"
);
assert (
    expectErr(
        Designs.setTradePolicy(mem, 1, { strict with max_coverage = ?100 }, true)
    ) == "requirements_invalid"
);

// Policy and tag stay mutable after publication because they are not art.
assert (expectOk(Designs.setTradePolicy(mem, 1, Memory.openRequirements(), false)) == ());
let ?policy = Designs.get(mem, 1) else Runtime.trap("design missing");
assert (Requirements.open(policy.requirements));
assert (not policy.nsfw);
assert (
    expectErr(Designs.setTradePolicy(mem, 99, Memory.openRequirements(), false)) == "not_found"
);

// Minting an instance of a published design increments the serial.
let firstChip = expectOk(Designs.mint(mem, 1, self, 400));
// The tag is read off the design at minting. This one was untagged a moment
// ago, so the chip is untagged even though it was tagged when it published.
assert (not firstChip.nsfw);
assert (firstChip.ref.designer == self);
assert (firstChip.ref.design_id == 1);
assert (firstChip.ref.serial == 1);
assert (firstChip.title == "Sunrise II");
assert (firstChip.design_revision == 2);
assert (firstChip.minted_at_ns == 400);
assert (firstChip.state == #held);
let secondChip = expectOk(Designs.mint(mem, 1, self, 401));
assert (secondChip.ref.serial == 2);
assert (expectErr(Designs.mint(mem, 2, self, 402)) == "not_published");
assert (expectErr(Designs.mint(mem, 99, self, 402)) == "not_found");

// Only published designs are visible to peers, in slot order.
let visible = Designs.published(mem);
assert (visible.size() == 1);
assert (visible[0].design_id == 1);

assert (expectOk(Designs.publish(mem, 3, 1, Memory.openRequirements(), false, 500)) == ());
let visibleAgain = Designs.published(mem);
assert (visibleAgain.size() == 2);
assert (visibleAgain[0].design_id == 1);
assert (visibleAgain[1].design_id == 3);
