import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import NeutronCapabilities "mo:neutron-capabilities";
import Holdings "./Holdings";
import Memory "./memory/chipswap/v6";
import Set "mo:core/Set";

// The designer directory and the crawl that fills it.
//
// Catalogs are not here. A peer's published designs are read by the browser,
// from the peer, and kept on the machine that asked; this canister keeps only
// who the owner knows and what it has concluded about them.
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

    // Whether we will spend a call on this designer at all. Both flags mean the
    // same thing here, which is the point: the crawl, the trade routes and the
    // page we serve peers all ask this one question.
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

    // --- Crawl -------------------------------------------------------------

    public type CrawlProgress = {
        active : Bool;
        queried : Nat;
        discovered : Nat;
        remaining : Nat;
        full : Bool;
    };

    public type CrawlTarget = {
        canister : Principal;
        offset : Nat;
    };

    public func startCrawl(mem : Memory.Mem, now : Int) : () {
        mem.crawl := ?{
            started_at_ns = now;
            var queried = 0;
            var discovered = 0;
            visited = Set.empty<Principal>();
            cursors = Map.empty<Principal, Nat>();
        };
    };

    public func stopCrawl(mem : Memory.Mem) : () {
        mem.crawl := null;
    };

    public func crawling(mem : Memory.Mem) : Bool {
        switch (mem.crawl) {
            case (?_) true;
            case null false;
        };
    };

    // The peers a step should call: those already part-read first, so a long
    // directory is finished rather than left half-collected behind newer work,
    // then eligible entries this crawl has not touched.
    public func crawlTargets(mem : Memory.Mem, limit : Nat) : [CrawlTarget] {
        let ?crawl = mem.crawl else return [];
        if (limit == 0) return [];
        // Both loops walk a map keyed by principal, which iterates in key
        // order, so a step's batch is the same batch every time it is derived
        // from the same state. A crawl that cannot be replayed cannot be
        // debugged from a bug report.
        let picked = List.empty<CrawlTarget>();
        for ((canister, offset) in Map.entries(crawl.cursors)) {
            if (List.size(picked) < limit) {
                // A cursor can outlive its entry: the designer was ignored, or
                // removed, while their directory was half-read. The frontier is
                // the table, so the table decides.
                switch (get(mem, canister)) {
                    case (?entry) if (active(entry)) List.add(picked, { canister; offset });
                    case null {};
                };
            };
        };
        for ((canister, entry) in Map.entries(mem.directory)) {
            if (
                List.size(picked) < limit and
                active(entry) and
                not Set.contains(crawl.visited, Principal.compare, canister) and
                Map.get(crawl.cursors, Principal.compare, canister) == null
            ) List.add(picked, { canister; offset = 0 });
        };
        List.toArray(picked);
    };

    // A peer answered with one page. `total` is a number they chose, so paging
    // on it is bounded twice over: the offset only advances while they are
    // actually sending entries, and it stops at the largest directory anyone
    // could honestly have. A peer claiming four billion entries and handing over
    // one at a time gets four pages like everybody else.
    public func noteCrawlPage(
        mem : Memory.Mem,
        canister : Principal,
        offset : Nat,
        entries : [Principal],
        total : Nat,
        self : Principal,
        now : Int,
    ) : Nat {
        let ?crawl = mem.crawl else return 0;
        // Refuse a page that does not answer the question we asked. A reply
        // arriving after the crawl was stopped and started again describes a
        // position in a walk that no longer exists, and acting on it would mark
        // a peer finished whose beginning this crawl never read.
        let expected = switch (Map.get(crawl.cursors, Principal.compare, canister)) {
            case (?value) value;
            case null 0;
        };
        if (expected != offset) return 0;
        if (Set.contains(crawl.visited, Principal.compare, canister)) return 0;

        var added = 0;
        for (candidate in entries.values()) {
            if (not Principal.equal(candidate, self)) {
                if (note(mem, candidate, #crawl, now)) added += 1;
            };
        };
        crawl.discovered += added;
        let next = offset + entries.size();
        if (entries.size() == 0 or next >= total or next >= MAX_DIRECTORY) {
            finishCrawlPeer(mem, canister);
        } else {
            Map.add(crawl.cursors, Principal.compare, canister, next);
        };
        added;
    };

    // A peer we will not ask again this crawl, because they answered everything
    // they had or because they did not answer at all.
    public func finishCrawlPeer(mem : Memory.Mem, canister : Principal) : () {
        let ?crawl = mem.crawl else return;
        Map.remove(crawl.cursors, Principal.compare, canister);
        if (not Set.contains(crawl.visited, Principal.compare, canister)) {
            Set.add(crawl.visited, Principal.compare, canister);
            crawl.queried += 1;
        };
    };

    public func crawlProgress(mem : Memory.Mem) : CrawlProgress {
        let ?crawl = mem.crawl else {
            return {
                active = false;
                queried = 0;
                discovered = 0;
                remaining = 0;
                full = Map.size(mem.directory) >= MAX_DIRECTORY;
            };
        };
        var remaining = 0;
        for ((canister, entry) in Map.entries(mem.directory)) {
            if (
                active(entry) and
                not Set.contains(crawl.visited, Principal.compare, canister)
            ) remaining += 1;
        };
        {
            active = true;
            queried = crawl.queried;
            discovered = crawl.discovered;
            remaining;
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
