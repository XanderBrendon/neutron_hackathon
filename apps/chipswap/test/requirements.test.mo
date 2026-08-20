import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Requirements "../backend/Requirements";
import Memory "../backend/memory/chipswap/v2";
import Shape "../backend/Shape";

// The arithmetic a trade turns on. `src/requirements.ts` runs the same
// comparisons so the store can predict this answer; the two must agree.

let PALETTE : [Nat32] = [0x000000, 0xffffff, 0x7fd1c1, 0x4f8ad8];

// `counts` gives how many pixels each palette index takes, in order. The rest
// of the chip is index 0.
func artOf(counts : [Nat]) : Memory.Art {
    let pixels = Array.tabulate<Nat8>(
        Shape.PIXEL_COUNT,
        func(index) {
            var seen = 0;
            var slot = 0;
            while (slot < counts.size()) {
                if (index < seen + counts[slot]) return Nat8.fromNat(slot);
                seen += counts[slot];
                slot += 1;
            };
            0;
        },
    );
    { shape_id = Shape.SHAPE_ID; palette = PALETTE; pixels = Blob.fromArray(pixels) };
};

func requirements(
    minColors : ?Nat,
    maxCoverage : ?Nat,
    nsfw : ?Memory.NsfwRule,
) : Memory.TradeRequirements {
    { approval = false; min_colors = minColors; max_coverage = maxCoverage; nsfw };
};

// --- measuring ------------------------------------------------------------

// A chip painted in one colour is one colour, covering all of it.
let plain = Requirements.measure(artOf([Shape.PIXEL_COUNT]));
assert (plain.colors == 1);
assert (plain.top_color_pixels == Shape.PIXEL_COUNT);
assert (plain.total_pixels == Shape.PIXEL_COUNT);

// Three colours, the largest holding 400 of the 757.
let mixed = Requirements.measure(artOf([400, 300, 57]));
assert (mixed.colors == 3);
assert (mixed.top_color_pixels == 400);

// A palette entry nothing paints is not a colour of this chip: padding the
// palette is not a way to satisfy a colour minimum.
let padded = Requirements.measure({
    artOf([400, 357]) with
    palette = Array.tabulate<Nat32>(Shape.MAX_PALETTE, func(i) { Nat32.fromNat(i) })
});
assert (padded.colors == 2);

// Two palette entries holding the same colour are one colour, and their pixels
// belong to it together.
let duplicated = Requirements.measure({
    artOf([400, 300, 57]) with palette = [0x000000, 0x000000, 0x7fd1c1, 0x4f8ad8]
});
assert (duplicated.colors == 2);
assert (duplicated.top_color_pixels == 700);

// --- colour minimum -------------------------------------------------------

assert (Requirements.check(requirements(?3, null, null), mixed, false) == null);
assert (Requirements.check(requirements(?4, null, null), mixed, false) == ?"min_colors");
// Exactly the minimum passes: it is "at least", not "more than".
assert (Requirements.check(requirements(?3, null, null), mixed, false) == null);

// --- coverage cap ---------------------------------------------------------

// 400 of 757 is over half, so a 50% cap refuses it and a 55% cap does not.
assert (Requirements.check(requirements(null, ?50, null), mixed, false) == ?"max_coverage");
assert (Requirements.check(requirements(null, ?55, null), mixed, false) == null);

// Compared without rounding: 303/757 is 40.03%, which a 40% cap refuses even
// though every sane way of printing it says "40%".
let justOver = Requirements.measure(artOf([303, 300, 154]));
assert (justOver.top_color_pixels == 303);
assert (Requirements.check(requirements(null, ?40, null), justOver, false) == ?"max_coverage");
let justUnder = Requirements.measure(artOf([302, 301, 154]));
assert (Requirements.check(requirements(null, ?40, null), justUnder, false) == null);

// --- the tag --------------------------------------------------------------

assert (Requirements.check(requirements(null, null, ? #disallowed), mixed, true) == ?"nsfw_disallowed");
assert (Requirements.check(requirements(null, null, ? #disallowed), mixed, false) == null);
assert (Requirements.check(requirements(null, null, ? #required), mixed, false) == ?"nsfw_required");
assert (Requirements.check(requirements(null, null, ? #required), mixed, true) == null);
// No rule means the tag is not consulted at all.
assert (Requirements.check(requirements(null, null, null), mixed, true) == null);

// --- combining ------------------------------------------------------------

// The first requirement that fails is the one reported, in the order a designer
// set them out: colours, then coverage, then the tag.
assert (Requirements.check(requirements(?9, ?10, ? #required), mixed, false) == ?"min_colors");
assert (Requirements.check(requirements(?2, ?10, ? #required), mixed, false) == ?"max_coverage");
assert (Requirements.check(requirements(?2, ?90, ? #required), mixed, false) == ?"nsfw_required");
assert (Requirements.check(requirements(?2, ?90, ? #required), mixed, true) == null);

// A design that asks for nothing accepts anything, including a single-colour
// chip that is entirely one colour and tagged.
assert (Requirements.check(Memory.openRequirements(), plain, true) == null);

// `checkArt` is `check` over art rather than a measurement already taken.
assert (Requirements.checkArt(requirements(?4, null, null), artOf([400, 300, 57]), false) == ?"min_colors");
assert (Requirements.checkArt(requirements(?3, null, null), artOf([400, 300, 57]), false) == null);

// --- validity -------------------------------------------------------------

assert (Requirements.valid(Memory.openRequirements()));
assert (Requirements.valid(requirements(?2, ?1, null)));
assert (Requirements.valid(requirements(?Shape.MAX_PALETTE, ?99, ? #required)));
// A minimum of one colour and a cap of a hundred percent restrict nothing, so
// they are not requirements a designer could have meant.
assert (not Requirements.valid(requirements(?1, null, null)));
assert (not Requirements.valid(requirements(null, ?100, null)));
assert (not Requirements.valid(requirements(null, ?0, null)));
assert (not Requirements.valid(requirements(?(Shape.MAX_PALETTE + 1), null, null)));

// --- shape of a policy ----------------------------------------------------

assert (Requirements.open(Memory.openRequirements()));
assert (not Requirements.restrictive(Memory.openRequirements()));
// Approval alone is neither open nor restrictive: it holds an offer that
// already qualifies rather than refusing one.
let approving = { Memory.openRequirements() with approval = true };
assert (not Requirements.open(approving));
assert (not Requirements.restrictive(approving));
assert (Requirements.restrictive(requirements(?3, null, null)));
assert (Requirements.restrictive(requirements(null, ?50, null)));
assert (Requirements.restrictive(requirements(null, null, ? #disallowed)));
