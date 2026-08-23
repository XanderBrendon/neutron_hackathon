import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import NeutronCapabilities "mo:neutron-capabilities";
import Holdings "./Holdings";
import Memory "./memory/chipswap/v7";

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
// A retired one behaves identically; the difference is who decided, and that
// difference is why an inbound proposal may clear `retired` and may never clear
// `ignored`.
module {
    public let MAX_DIRECTORY : Nat = 512;

    // Consecutive unanswered calls before we conclude a designer is gone. One
    // failure is a bad moment; three in a row, with any reply in between
    // clearing the count, is a canister that no longer answers.
    public let RETIRE_STRIKES : Nat = 3;

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
                        retired = false;
                        strikes = 0;
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

    public func retired(mem : Memory.Mem, canister : Principal) : Bool {
        switch (get(mem, canister)) {
            case (?entry) entry.retired;
            case null false;
        };
    };

    // Whether this designer may be approached at all. Both flags mean the same
    // thing here, which is the point: the trade routes, the page we serve
    // peers, and the frontier we hand a crawl all ask this one question.
    public func active(entry : Memory.DirectoryEntry) : Bool {
        not entry.ignored and not entry.retired;
    };

    public func reachable(mem : Memory.Mem, canister : Principal) : Bool {
        switch (get(mem, canister)) {
            case (?entry) active(entry);
            case null true;
        };
    };

    // A designer answered. Whatever they said, they are there, so the strike
    // count goes back to zero and a retirement we had concluded is withdrawn.
    public func noteReachable(mem : Memory.Mem, canister : Principal, now : Int) : () {
        let ?existing = get(mem, canister) else return;
        Map.add(
            mem.directory,
            Principal.compare,
            canister,
            { existing with last_seen_ns = now; strikes = 0; retired = false },
        );
    };

    // Which backend-call failure is evidence about the peer rather than about
    // us. A rejection is their canister declining to run our dispatcher at all;
    // every other code the broker returns describes something that went wrong on
    // this side, and striking a designer for our own concurrency limit would be
    // unjust.
    public func strikeable(code : Text) : Bool {
        code == "call_rejected";
    };

    // What one paid call's outcome says about the designer we made it to.
    // Returns true when this is the outcome that retires them, so the caller
    // can say so once rather than re-deriving it.
    //
    // Only the paid update routes may pass through here. A query must never
    // reach it: those routes exist only from version 108, and a peer on an
    // older release exposes no query dispatcher at all — retiring them for
    // having yet to upgrade would be a lie about the one thing this flag
    // claims to know.
    //
    // An answer we could not decode is still an answer. The bytes prove a
    // canister ran our dispatcher and replied, which is the whole question
    // this flag asks; whether we could read them is our problem, not evidence
    // about them.
    public func noteCallResult(
        mem : Memory.Mem,
        canister : Principal,
        result : NeutronCapabilities.BackendCallResultV1,
        now : Int,
    ) : Bool {
        switch (result) {
            case (#ok(_)) {
                noteReachable(mem, canister, now);
                false;
            };
            case (#err(error)) {
                if (not strikeable(error.code)) return false;
                noteUnreachable(mem, canister, now);
            };
        };
    };

    public func noteUnreachable(mem : Memory.Mem, canister : Principal, now : Int) : Bool {
        let ?existing = get(mem, canister) else return false;
        if (existing.retired) return false;
        let strikes = existing.strikes + 1;
        let retire = strikes >= RETIRE_STRIKES;
        Map.add(
            mem.directory,
            Principal.compare,
            canister,
            { existing with last_seen_ns = now; strikes; retired = retire },
        );
        retire;
    };

    // The owner overruling a conclusion we drew. Clearing it also clears the
    // evidence, so a designer put back into rotation gets a full three chances
    // rather than being one bad call from retirement again.
    public func setRetired(
        mem : Memory.Mem,
        canister : Principal,
        retire : Bool,
    ) : Bool {
        let ?existing = get(mem, canister) else return false;
        Map.add(
            mem.directory,
            Principal.compare,
            canister,
            { existing with retired = retire; strikes = 0 },
        );
        true;
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
    // Ignored and retired designers are withheld. Withholding is the whole of
    // what ignoring means to anyone else.
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
                not entry.retired and
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
