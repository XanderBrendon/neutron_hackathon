import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import NeutronCapabilities "mo:neutron-capabilities";
import Holdings "./Holdings";
import Memory "./memory/chipswap/v10";
import Wire "./Wire";

// The designer directory: who the owner knows, and what we have concluded
// about them.
//
// Neither the catalogs nor the crawl are here any more. A peer's published
// designs are read by the browser, from the peer, and kept on the machine that
// asked. The walk that finds new designers is the browser's too, and reaches
// this module only as its result — a batch of addresses handed to `noteFound`
// when the crawl is done. What stays here is every judgement about a designer,
// because that is the owner's data rather than a passing state.
//
// Nothing arrives here unasked, with one exception the table names out loud. A
// designer is here because the owner typed them in, because they proposed a
// trade, or because a crawl the owner started read them out of a peer's
// directory. The exception is the `#seed` entry a clean install begins with,
// which exists because every one of those routes needs somebody already in the
// table to start from. It is labelled as what it is and removed like anything
// else.
//
// An ignored entry is inert in every outward direction. It is not fetched from,
// not crawled, and not served to peers, but it is still an entry, so a crawl
// finding the designer again cannot quietly reinstate them.
//
// It is also the only judgement here, and deliberately the only one. This
// module used to keep a second flag that meant the same thing outwardly and
// something quite different inwardly: `retired`, which this canister set for
// itself after three paid calls a designer failed to answer. It is gone. The
// kernel does not say why a call was rejected, so that flag was guessing from
// silence, and a canister briefly stopped was indistinguishable from one
// uninstalled. Meanwhile the reader that actually notices a dead designer — the
// browser, fetching catalogs — could never touch it, because a peer who has
// merely not upgraded refuses a query too.
//
// So the judgement is not made here at all now. The browser reports what
// happened when it asked, the owner reads it, and what they decide arrives as
// an ignore or a removal. This module keeps decisions; it no longer draws them.
module {
    public let MAX_DIRECTORY : Nat = 512;

    public func get(mem : Memory.Mem, canister : Principal) : ?Memory.DirectoryEntry {
        Map.get(mem.directory, Principal.compare, canister);
    };

    // Returns true when the entry is new. Repeat sightings only refresh
    // `last_seen_ns`, keeping the original source attribution.
    public func note(
        mem : Memory.Mem,
        canister : Principal,
        source : Memory.DirectorySource,
        now : Int,
    ) : Bool {
        switch (get(mem, canister)) {
            case (?existing) {
                Map.add(
                    mem.directory,
                    Principal.compare,
                    canister,
                    { existing with last_seen_ns = now },
                );
                false;
            };
            case null {
                if (Map.size(mem.directory) >= MAX_DIRECTORY) evictOne(mem);
                if (Map.size(mem.directory) >= MAX_DIRECTORY) return false;
                Map.add(
                    mem.directory,
                    Principal.compare,
                    canister,
                    {
                        canister;
                        source;
                        first_seen_ns = now;
                        last_seen_ns = now;
                        ignored = false;
                        // A designer arrives with nothing turned away. The
                        // owner has not seen their chips yet, so there is
                        // nothing they could have decided about one.
                        ignored_designs = [];
                    },
                );
                true;
            };
        };
    };

    public func noteExcludingSelf(
        mem : Memory.Mem,
        canister : Principal,
        self : Principal,
        source : Memory.DirectorySource,
        now : Int,
    ) : Bool {
        if (Principal.equal(canister, self)) return false;
        note(mem, canister, source, now);
    };

    public func ignored(mem : Memory.Mem, canister : Principal) : Bool {
        switch (get(mem, canister)) {
            case (?entry) entry.ignored;
            case null false;
        };
    };

    // Whether this designer may be approached at all. One flag answers it, and
    // one question is asked of it: the trade routes, the page we serve peers,
    // and the frontier we hand a crawl all come through here.
    public func active(entry : Memory.DirectoryEntry) : Bool {
        not entry.ignored;
    };

    public func reachable(mem : Memory.Mem, canister : Principal) : Bool {
        switch (get(mem, canister)) {
            case (?entry) active(entry);
            case null true;
        };
    };

    // A designer answered, so we have seen them. That is the whole of what one
    // call tells us and the whole of what we record.
    public func noteReachable(mem : Memory.Mem, canister : Principal, now : Int) : () {
        let ?existing = get(mem, canister) else return;
        Map.add(
            mem.directory,
            Principal.compare,
            canister,
            { existing with last_seen_ns = now },
        );
    };

    // What one paid call's outcome says about the designer we made it to.
    //
    // An answer, however garbled, proves a canister ran our dispatcher and
    // replied — the bytes are the evidence, and whether we could read them is
    // our problem rather than a fact about them. Silence proves nothing and is
    // recorded as nothing: the kernel does not say whether the peer refused,
    // was stopped, or was briefly out of cycles, and a table that wrote down a
    // guess would only be preserving it.
    //
    // What does notice a designer who has genuinely gone is the browser, which
    // reads their catalog and is told by the owner what to do about it.
    public func noteCallResult(
        mem : Memory.Mem,
        canister : Principal,
        result : NeutronCapabilities.BackendCallResultV1,
        now : Int,
    ) : () {
        switch (result) {
            case (#ok(_)) noteReachable(mem, canister, now);
            case (#err(_)) {};
        };
    };

    // Ignoring is a flag and nothing more. The catalog it used to drop lives in
    // the browser now, which evicts it on the same gesture: an ignored designer
    // should not stay on display, and the copy on display is the one to remove.
    public func setIgnored(
        mem : Memory.Mem,
        canister : Principal,
        ignore_ : Bool,
    ) : Bool {
        switch (get(mem, canister)) {
            case (?existing) {
                Map.add(
                    mem.directory,
                    Principal.compare,
                    canister,
                    { existing with ignored = ignore_ },
                );
                true;
            };
            case null false;
        };
    };

    // --- Turning away one chip --------------------------------------------

    // The narrow sibling of `setIgnored`. Ignoring a designer withholds their
    // whole catalogue and stops it being fetched; this withholds one chip from
    // the Market and changes nothing else — their catalogue is still read,
    // because the other chips are still wanted, and the design is still
    // tradeable, because a chip you would rather not look at is not one you are
    // forbidden to acquire.
    //
    // The ceiling is what a catalogue can show. A peer's reply is refused past
    // `Wire.MAX_DESIGNS` designs, so that is the most of one designer the owner
    // could ever have been shown and therefore the most they could ever have
    // turned away. Reaching it in ordinary use is not possible, which is the
    // point: it bounds the table without ever standing in the owner's way.
    public let MAX_IGNORED_DESIGNS : Nat = Wire.MAX_DESIGNS;

    public type IgnoreResult = { #ok; #err : Text };

    public func designIgnored(
        mem : Memory.Mem,
        canister : Principal,
        designId : Nat,
    ) : Bool {
        switch (get(mem, canister)) {
            case (?entry) contains(entry.ignored_designs, designId);
            case null false;
        };
    };

    func contains(ids : [Nat], designId : Nat) : Bool {
        for (id in ids.values()) {
            if (id == designId) return true;
        };
        false;
    };

    // Asking for the state the entry is already in succeeds and writes nothing,
    // so a double press is not an error and neither is un-ignoring a chip that
    // was never turned away: the owner asked for a state, and that state is
    // what they get.
    public func setDesignIgnored(
        mem : Memory.Mem,
        canister : Principal,
        designId : Nat,
        ignore_ : Bool,
    ) : IgnoreResult {
        // An id outside what the wire carries one in did not come from a peer's
        // catalogue and cannot name a chip anybody was shown.
        if (designId == 0 or designId > Wire.MAX_DESIGN_ID) return #err("design_invalid");
        let ?existing = get(mem, canister) else return #err("not_found");
        let held = existing.ignored_designs;
        if (contains(held, designId) == ignore_) return #ok;

        let updated = if (ignore_) {
            // A full list is a reason to refuse another, never a reason to
            // refuse taking one off — the way out of the ceiling must not be
            // behind it.
            if (held.size() >= MAX_IGNORED_DESIGNS) return #err("ignore_limit");
            // Ascending and without repeats: a set has no order of its own, so
            // giving it one keeps two equal lists from reading as different.
            Array.sort<Nat>(Array.concat<Nat>(held, [designId]), Nat.compare);
        } else {
            Array.filter<Nat>(held, func(id) { id != designId });
        };

        Map.add(
            mem.directory,
            Principal.compare,
            canister,
            { existing with ignored_designs = updated },
        );
        #ok;
    };

    public func remove(mem : Memory.Mem, canister : Principal) : Bool {
        switch (get(mem, canister)) {
            case (?_) {
                Map.remove(mem.directory, Principal.compare, canister);
                true;
            };
            case null false;
        };
    };

    // This canister is never a designer in its own directory, and every route
    // that writes one already says so: `chipswap_directory_add` refuses its own
    // address, a crawl and a trade both go through `noteExcludingSelf`, and the
    // page served to peers filters it out again on the way out.
    //
    // The seed a clean install ships with is the one entry written before this
    // canister knows what its own address is, so it is the one the filters
    // cannot cover — and the owner of the seeded address installing Chipswap is
    // exactly the case that produces it. Dropping it at construction keeps the
    // invariant true of the table itself rather than of each reader of it.
    public func dropSelf(mem : Memory.Mem, self : Principal) : Bool {
        remove(mem, self);
    };

    public type ServedPage = {
        entries : [Principal];
        total : Nat;
    };

    // The page a peer's crawl reads. Ordered by principal rather than by
    // `last_seen_ns`, because a caller walks this in several calls and a sort
    // that shifts between them makes a paginated read skip entries and repeat
    // others. Principals do not move.
    //
    // Ignored designers are withheld, and nobody else is. Withholding is the
    // whole of what ignoring means to anyone else, and a designer who has not
    // answered *us* is still somebody the peer asking might reach.
    public func served(
        mem : Memory.Mem,
        self : Principal,
        offset : Nat,
        limit : Nat,
    ) : ServedPage {
        let all = Array.sort<(Principal, Memory.DirectoryEntry)>(
            Map.toArray(mem.directory),
            func(left, right) { Principal.compare(left.0, right.0) },
        );
        let eligible = List.empty<Principal>();
        for ((canister, entry) in all.values()) {
            if (active(entry) and not Principal.equal(canister, self)) {
                List.add(eligible, canister);
            };
        };
        let total = List.size(eligible);
        if (offset >= total or limit == 0) return { entries = []; total };
        let available : Nat = total - offset;
        let take = if (limit < available) limit else available;
        {
            entries = Array.tabulate<Principal>(
                take,
                func(i) { List.at(eligible, offset + i) },
            );
            total;
        };
    };

    // --- What a crawl brings back ------------------------------------------

    // The result of one crawl, seated in one call.
    //
    // The walk that produced this list happened in the browser, which is where
    // a walk belongs: it is meaningful for about ninety seconds and costs this
    // canister nothing to have skipped. What arrives here is only its
    // conclusion — a batch of addresses, once, when the crawl finished or was
    // stopped.
    //
    // Every rule about who may be in the table is still this module's. A
    // batch cannot introduce this canister to itself, cannot reinstate an
    // ignored designer, cannot overwrite how we actually met somebody, and
    // cannot grow the table past `MAX_DIRECTORY`.
    public type FoundSummary = {
        // Designers who were not here and now are.
        added : Nat;
        // Designers the table already had, plus this canister itself, plus any
        // the table had no room to seat. `added + skipped` is always the size
        // of the batch, so a caller can report what became of every address it
        // offered rather than assuming they all landed.
        skipped : Nat;
        full : Bool;
    };

    // A batch fills the room the table has. It never evicts.
    //
    // This is the one place `note`'s eviction is deliberately not used, and the
    // reason is that a batch is the only caller that can collide with itself. A
    // crawl offering ten designers into a full table would, entry by entry,
    // evict the ones it had just seated — leaving two of the ten and reporting
    // ten, which is the number the owner would then see. Every other route
    // writes one designer the owner is actively dealing with, and eviction
    // there is a fair trade for a designer who arrived long ago and has not
    // been seen since.
    //
    // So a crawl gets the empty seats and no more. `#crawl` is the least
    // authoritative source there is, and a directory that reshuffled itself
    // every time the owner pressed "Find more designers" would be worse than
    // one that filled up and said so.
    public func noteFound(
        mem : Memory.Mem,
        canisters : [Principal],
        self : Principal,
        now : Int,
    ) : FoundSummary {
        var added = 0;
        var skipped = 0;
        for (canister in canisters.values()) {
            if (Principal.equal(canister, self)) {
                skipped += 1;
            } else switch (get(mem, canister)) {
                case (?_) {
                    // Already known. The sighting is still worth recording —
                    // it is evidence the designer is still being passed
                    // around — but it changes nothing else about the entry.
                    ignore note(mem, canister, #crawl, now);
                    skipped += 1;
                };
                case null {
                    if (Map.size(mem.directory) >= MAX_DIRECTORY) {
                        skipped += 1;
                    } else {
                        ignore note(mem, canister, #crawl, now);
                        added += 1;
                    };
                };
            };
        };
        {
            added;
            skipped;
            full = Map.size(mem.directory) >= MAX_DIRECTORY;
        };
    };

    func evictOne(mem : Memory.Mem) : () {
        var victim : ?(Principal, Int) = null;
        for ((canister, entry) in Map.entries(mem.directory)) {
            if (
                not chosen(entry) and
                not entry.ignored and
                not Holdings.ownsAnyFrom(mem, canister)
            ) {
                switch (victim) {
                    case (?(_, seen)) {
                        if (entry.last_seen_ns < seen) victim := ?(canister, entry.last_seen_ns);
                    };
                    case null victim := ?(canister, entry.last_seen_ns);
                };
            };
        };
        switch (victim) {
            case (?(canister, _)) {
                Map.remove(mem.directory, Principal.compare, canister);
            };
            case null {};
        };
    };

    // An entry the owner put here on purpose, rather than one that arrived.
    // The seed is neither chosen nor, by the time this matters, needed: a table
    // at its limit has found five hundred designers, which is what the seed was
    // there to start.
    func chosen(entry : Memory.DirectoryEntry) : Bool {
        switch (entry.source) {
            case (#manual or #contacts) true;
            case (#trade or #crawl or #seed) false;
        };
    };

    // Directory rows for the tile, most recently seen first.
    public type DirectoryPage = {
        entries : [Memory.DirectoryEntry];
        total : Nat;
    };

    public func page(mem : Memory.Mem, offset : Nat, limit : Nat) : DirectoryPage {
        let all = Array.sort<(Principal, Memory.DirectoryEntry)>(
            Map.toArray(mem.directory),
            func(left, right) {
                switch (Int.compare(right.1.last_seen_ns, left.1.last_seen_ns)) {
                    case (#equal) Principal.compare(left.0, right.0);
                    case (order) order;
                };
            },
        );
        let total = all.size();
        if (offset >= total or limit == 0) return { entries = []; total };
        let available : Nat = total - offset;
        let take = if (limit < available) limit else available;
        {
            entries = Array.tabulate<Memory.DirectoryEntry>(
                take,
                func(i) { all[offset + i].1 },
            );
            total;
        };
    };

    // Text form used by tile payloads and log-free error codes.
    public func sourceText(source : Memory.DirectorySource) : Text {
        switch (source) {
            case (#manual) "manual";
            case (#contacts) "contacts";
            case (#trade) "trade";
            case (#crawl) "crawl";
            case (#seed) "seed";
        };
    };

    public func natText(value : Nat) : Text = Nat.toText(value);

    public func textCompare(left : Text, right : Text) : { #less; #equal; #greater } = Text.compare(left, right);
}
