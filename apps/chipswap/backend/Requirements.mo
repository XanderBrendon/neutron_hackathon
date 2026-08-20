import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Memory "./memory/chipswap/v3";
import Shape "./Shape";

// What a designer asks of a chip offered for one of their designs, and the
// arithmetic that decides whether an offer meets it.
//
// The measurement runs on the receiving side, over the offered art itself,
// which crosses the wire in full. A peer cannot assert that its chip has twelve
// colours; it hands over the pixels and we count them. The one claim we cannot
// check is the NSFW tag, which is the offering canister's word about its own
// art in the same way the title is.
//
// The chip's palette is not the measure of its colours: a palette may hold
// sixty-four entries and paint three of them, and two entries may hold the same
// colour. Both are counted the way an eye would count them, over the pixels.
module {
    public let MIN_COLORS_FLOOR : Nat = 2;
    public let MIN_COLORS_CEILING : Nat = Shape.MAX_PALETTE;
    public let MAX_COVERAGE_FLOOR : Nat = 1;
    public let MAX_COVERAGE_CEILING : Nat = 99;

    public type Metrics = {
        /** Distinct colour values the art actually paints. */
        colors : Nat;
        /** Pixels held by the single most-used colour. */
        top_color_pixels : Nat;
        /** Pixels the art covers; the divisor for a coverage percentage. */
        total_pixels : Nat;
    };

    public func measure(art : Memory.Art) : Metrics {
        let counts = Map.empty<Nat32, Nat>();
        var total = 0;
        for (index in art.pixels.values()) {
            let slot = Nat8.toNat(index);
            // Art reaching this point has been validated, so the index is in
            // range; a stray one is simply not counted rather than trapping.
            if (slot < art.palette.size()) {
                let colour = art.palette[slot];
                let seen = switch (Map.get(counts, Nat32.compare, colour)) {
                    case (?value) value;
                    case null 0;
                };
                Map.add(counts, Nat32.compare, colour, seen + 1);
                total += 1;
            };
        };
        var top = 0;
        for ((_, count) in Map.entries(counts)) {
            if (count > top) top := count;
        };
        { colors = Map.size(counts); top_color_pixels = top; total_pixels = total };
    };

    /**
     * The reason an offer fails, or null when it satisfies every requirement.
     * `approval` is not consulted here: it decides what happens to an offer that
     * already qualifies, not whether it qualifies.
     */
    public func check(
        requirements : Memory.TradeRequirements,
        offered : Metrics,
        offeredNsfw : Bool,
    ) : ?Text {
        switch (requirements.min_colors) {
            case (?minimum) if (offered.colors < minimum) return ?"min_colors";
            case null {};
        };
        switch (requirements.max_coverage) {
            case (?percent) {
                // Compared as a cross-multiplication so no rounding decides a
                // trade: 303 of 757 pixels is over 40% and fails a 40% cap,
                // however the tile chooses to print it.
                if (offered.top_color_pixels * 100 > percent * offered.total_pixels) {
                    return ?"max_coverage";
                };
            };
            case null {};
        };
        switch (requirements.nsfw) {
            case (?#disallowed) if (offeredNsfw) return ?"nsfw_disallowed";
            case (?#required) if (not offeredNsfw) return ?"nsfw_required";
            case null {};
        };
        null;
    };

    /** `check` against art rather than a measurement already taken. */
    public func checkArt(
        requirements : Memory.TradeRequirements,
        art : Memory.Art,
        offeredNsfw : Bool,
    ) : ?Text {
        check(requirements, measure(art), offeredNsfw);
    };

    /**
     * Whether a requirement set is one a designer could have meant. A minimum of
     * one colour and a cap of a hundred percent are satisfied by every chip that
     * exists, so they are refused rather than stored as requirements that read
     * as restrictions and are not.
     */
    public func valid(requirements : Memory.TradeRequirements) : Bool {
        switch (requirements.min_colors) {
            case (?minimum) {
                if (minimum < MIN_COLORS_FLOOR or minimum > MIN_COLORS_CEILING) return false;
            };
            case null {};
        };
        switch (requirements.max_coverage) {
            case (?percent) {
                if (percent < MAX_COVERAGE_FLOOR or percent > MAX_COVERAGE_CEILING) return false;
            };
            case null {};
        };
        true;
    };

    /** True when a design asks for nothing at all and swaps freely. */
    public func open(requirements : Memory.TradeRequirements) : Bool {
        not requirements.approval and
        requirements.min_colors == null and
        requirements.max_coverage == null and
        requirements.nsfw == null;
    };

    /** True when a design refuses offers on their artwork, approval aside. */
    public func restrictive(requirements : Memory.TradeRequirements) : Bool {
        requirements.min_colors != null or
        requirements.max_coverage != null or
        requirements.nsfw != null;
    };
}
