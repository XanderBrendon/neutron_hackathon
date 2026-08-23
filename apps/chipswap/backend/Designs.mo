import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Text "mo:core/Text";
import Memory "./memory/chipswap/v6";
import Requirements "./Requirements";
import Shape "./Shape";

// The ten design slots and their lifecycle. A draft occupies a slot until it is
// deleted or published; publishing consumes the slot permanently and freezes the
// title and art. Only the trade policy — what a designer asks in exchange, and
// whether the chip carries an NSFW tag — stays mutable afterwards.
module {
    public type Result<T> = { #ok : T; #err : Text };

    public let MAX_SLOTS : Nat = 10;
    public let MAX_TITLE_CHARS : Nat = 48;

    // A new draft opens with a usable working palette rather than one color, so
    // the editor has something to blend and lock against immediately.
    let STARTER_PALETTE : [Nat32] = [
        0x0e141a,
        0xf2f5f7,
        0x7fd1c1,
        0x4f8ad8,
        0xe0b062,
        0xd2607a,
    ];

    public func get(mem : Memory.Mem, id : Nat) : ?Memory.Design {
        Map.get(mem.designs, Nat.compare, id);
    };

    public func slotsUsed(mem : Memory.Mem) : Nat {
        Map.size(mem.designs);
    };

    public func create(mem : Memory.Mem, title : Text, now : Int) : Result<Nat> {
        let cleaned = switch (normalizeTitle(title)) {
            case (#err(code)) return #err(code);
            case (#ok(value)) value;
        };
        if (slotsUsed(mem) >= MAX_SLOTS) return #err("slot_limit");
        let ?slot = firstFreeSlot(mem) else return #err("slot_limit");
        Map.add(
            mem.designs,
            Nat.compare,
            slot,
            {
                design_id = slot;
                title = cleaned;
                art = {
                    shape_id = Shape.SHAPE_ID;
                    palette = STARTER_PALETTE;
                    pixels = Blob.fromArray(
                        Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(_) { 0 })
                    );
                };
                state = #draft;
                // A new draft asks nothing of anyone: whoever wants it may swap
                // for it. Requirements are added deliberately, never inherited.
                requirements = Memory.openRequirements();
                nsfw = false;
                revision = 1;
                created_at_ns = now;
                published_at_ns = null;
                next_serial = 1;
            },
        );
        #ok(slot);
    };

    // Returns the new revision.
    public func save(
        mem : Memory.Mem,
        id : Nat,
        expectedRevision : Nat,
        title : Text,
        palette : [Nat32],
        pixels : Blob,
    ) : Result<Nat> {
        let ?design = get(mem, id) else return #err("not_found");
        if (design.state == #published) return #err("immutable");
        let cleaned = switch (normalizeTitle(title)) {
            case (#err(code)) return #err(code);
            case (#ok(value)) value;
        };
        if (design.revision != expectedRevision) return #err("revision_conflict");
        switch (Shape.validateArt(Shape.SHAPE_ID, palette.size(), pixels)) {
            case (?code) return #err(code);
            case null {};
        };
        let revision = design.revision + 1;
        Map.add(
            mem.designs,
            Nat.compare,
            id,
            {
                design with
                title = cleaned;
                art = {
                    shape_id = Shape.SHAPE_ID;
                    palette;
                    pixels;
                };
                revision;
                published_at_ns = null;
            } : Memory.Design,
        );
        #ok(revision);
    };

    public func delete(mem : Memory.Mem, id : Nat) : Result<()> {
        let ?design = get(mem, id) else return #err("not_found");
        if (design.state == #published) return #err("immutable");
        Map.remove(mem.designs, Nat.compare, id);
        #ok(());
    };

    public func publish(
        mem : Memory.Mem,
        id : Nat,
        expectedRevision : Nat,
        requirements : Memory.TradeRequirements,
        nsfw : Bool,
        now : Int,
    ) : Result<()> {
        let ?design = get(mem, id) else return #err("not_found");
        if (design.state == #published) return #err("immutable");
        if (design.revision != expectedRevision) return #err("revision_conflict");
        if (not Requirements.valid(requirements)) return #err("requirements_invalid");
        switch (
            Shape.validateArt(design.art.shape_id, design.art.palette.size(), design.art.pixels)
        ) {
            case (?code) return #err(code);
            case null {};
        };
        Map.add(
            mem.designs,
            Nat.compare,
            id,
            {
                design with
                state = #published;
                requirements;
                nsfw;
                published_at_ns = ?now;
            } : Memory.Design,
        );
        #ok(());
    };

    // Policy and label together, because they are the two things about a design
    // that survive publication and they are always edited in one breath.
    public func setTradePolicy(
        mem : Memory.Mem,
        id : Nat,
        requirements : Memory.TradeRequirements,
        nsfw : Bool,
    ) : Result<()> {
        let ?design = get(mem, id) else return #err("not_found");
        if (not Requirements.valid(requirements)) return #err("requirements_invalid");
        Map.add(mem.designs, Nat.compare, id, { design with requirements; nsfw });
        #ok(());
    };

    // Mints one instance to hand to a peer. The designer never loses anything by
    // minting, which is why an own-design offer escrows nothing.
    public func mint(
        mem : Memory.Mem,
        id : Nat,
        self : Principal,
        now : Int,
    ) : Result<Memory.Chip> {
        let ?design = get(mem, id) else return #err("not_found");
        if (design.state != #published) return #err("not_published");
        let serial = design.next_serial;
        Map.add(
            mem.designs,
            Nat.compare,
            id,
            { design with next_serial = serial + 1 },
        );
        #ok({
            ref = { designer = self; design_id = id; serial };
            title = design.title;
            art = design.art;
            // Read off the design once, here. A designer may retag their design
            // later; a chip that has already changed hands keeps what it left
            // with, so nobody's collection is relabeled behind their back.
            nsfw = design.nsfw;
            design_revision = design.revision;
            minted_at_ns = now;
            acquired_at_ns = now;
            state = #held;
        });
    };

    // Published designs in slot order. Drafts are never visible to peers.
    public func published(mem : Memory.Mem) : [Memory.Design] {
        let all = Array.sort<(Nat, Memory.Design)>(
            Map.toArray(mem.designs),
            func(left, right) { Nat.compare(left.0, right.0) },
        );
        Array.filterMap<(Nat, Memory.Design), Memory.Design>(
            all,
            func(entry) {
                if (entry.1.state == #published) ?entry.1 else null;
            },
        );
    };

    func firstFreeSlot(mem : Memory.Mem) : ?Nat {
        var slot = 1;
        while (slot <= MAX_SLOTS) {
            if (Map.get(mem.designs, Nat.compare, slot) == null) return ?slot;
            slot += 1;
        };
        null;
    };

    // Trimmed, bounded, and free of control characters so a hostile or careless
    // title cannot break the tile or a peer's store listing.
    func normalizeTitle(title : Text) : Result<Text> {
        let trimmed = Text.trim(title, #predicate(func(c : Char) { c <= ' ' }));
        var count = 0;
        for (character in trimmed.chars()) {
            if (Char.toNat32(character) < 0x20) return #err("title_invalid");
            count += 1;
        };
        if (count == 0 or count > MAX_TITLE_CHARS) return #err("title_invalid");
        #ok(trimmed);
    };
}
