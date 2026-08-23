import Array "mo:core/Array";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Memory "./memory/chipswap/v7";

// The chips this Neutron holds. A chip is spendable only while `#held`: an offer
// in flight is `#escrowed`, and an offer whose outcome was never confirmed is
// `#uncertain`. Neither can be offered again, because the peer may already have
// admitted it.
module {
    public type Result<T> = { #ok : T; #err : Text };

    public let MAX_HOLDINGS : Nat = 500;

    public func key(ref : Memory.ChipRef) : Text {
        Principal.toText(ref.designer) # "." # Nat.toText(ref.design_id) # "."
        # Nat.toText(ref.serial);
    };

    public func count(mem : Memory.Mem) : Nat {
        Map.size(mem.holdings);
    };

    public func get(mem : Memory.Mem, chipKey : Text) : ?Memory.Chip {
        Map.get(mem.holdings, Text.compare, chipKey);
    };

    public func spendable(mem : Memory.Mem, chipKey : Text) : Bool {
        switch (get(mem, chipKey)) {
            case (?chip) chip.state == #held;
            case null false;
        };
    };

    public func admit(mem : Memory.Mem, chip : Memory.Chip) : Result<()> {
        let chipKey = key(chip.ref);
        if (Map.get(mem.holdings, Text.compare, chipKey) != null) return #err("duplicate");
        if (count(mem) >= MAX_HOLDINGS) return #err("holdings_full");
        Map.add(mem.holdings, Text.compare, chipKey, { chip with state = #held });
        #ok(());
    };

    public func escrow(
        mem : Memory.Mem,
        chipKey : Text,
        requestId : Blob,
        peer : Principal,
        now : Int,
    ) : Result<Memory.Chip> {
        let ?chip = get(mem, chipKey) else return #err("not_found");
        if (chip.state != #held) return #err("not_available");
        let updated = {
            chip with
            state = #escrowed({ request_id = requestId; peer; since_ns = now })
        };
        Map.add(mem.holdings, Text.compare, chipKey, updated);
        #ok(updated);
    };

    public func markUncertain(mem : Memory.Mem, chipKey : Text) : Result<()> {
        let ?chip = get(mem, chipKey) else return #err("not_found");
        switch (chip.state) {
            case (#escrowed(details)) {
                Map.add(
                    mem.holdings,
                    Text.compare,
                    chipKey,
                    { chip with state = #uncertain(details) },
                );
                #ok(());
            };
            case (#uncertain(_)) #ok(());
            case (#held) #err("not_escrowed");
        };
    };

    public func release(mem : Memory.Mem, chipKey : Text) : Result<()> {
        let ?chip = get(mem, chipKey) else return #err("not_found");
        Map.add(mem.holdings, Text.compare, chipKey, { chip with state = #held });
        #ok(());
    };

    public func consume(mem : Memory.Mem, chipKey : Text) : Result<()> {
        let ?_chip = get(mem, chipKey) else return #err("not_found");
        Map.remove(mem.holdings, Text.compare, chipKey);
        #ok(());
    };

    public func ownsDesign(
        mem : Memory.Mem,
        designer : Principal,
        designId : Nat,
    ) : Bool {
        for ((_, chip) in Map.entries(mem.holdings)) {
            if (
                Principal.equal(chip.ref.designer, designer) and
                chip.ref.design_id == designId
            ) return true;
        };
        false;
    };

    public func ownsAnyFrom(mem : Memory.Mem, designer : Principal) : Bool {
        for ((_, chip) in Map.entries(mem.holdings)) {
            if (Principal.equal(chip.ref.designer, designer)) return true;
        };
        false;
    };

    public type Page = {
        chips : [Memory.Chip];
        total : Nat;
    };

    // Newest acquisition first, with the chip key breaking ties so paging is
    // stable across calls.
    public func page(mem : Memory.Mem, offset : Nat, limit : Nat) : Page {
        let all = Array.sort<(Text, Memory.Chip)>(
            Map.toArray(mem.holdings),
            func(left, right) {
                switch (Int.compare(right.1.acquired_at_ns, left.1.acquired_at_ns)) {
                    case (#equal) Text.compare(left.0, right.0);
                    case (order) order;
                };
            },
        );
        let total = all.size();
        if (offset >= total or limit == 0) return { chips = []; total };
        let available : Nat = total - offset;
        let take = if (limit < available) limit else available;
        {
            chips = Array.tabulate<Memory.Chip>(take, func(i) { all[offset + i].1 });
            total;
        };
    };
}
