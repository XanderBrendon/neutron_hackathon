import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Holdings "./Holdings";
import Memory "./memory/chipswap/v4";
import Set "mo:core/Set";
import Requirements "./Requirements";

// The designer directory, the cached catalogs the store reads from, and the
// crawl that fills both.
//
// Nothing arrives here unasked. A designer is in this table because the owner
// typed them in, because they proposed a trade, or because a crawl the owner
// started read them out of a peer's directory.
//
// An ignored entry is inert in every outward direction. It is not fetched from,
// not crawled, not served to peers, and not read by the store, but it is still
// an entry, so a crawl finding the designer again cannot quietly reinstate them.
// A retired one behaves identically; the difference is who decided, and that
// difference is why an inbound proposal may clear `retired` and may never clear
// `ignored`.
module {
    public let MAX_DIRECTORY : Nat = 512;
    public let MAX_CATALOG_CACHE : Nat = 32;

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
                        last_catalog_ns = null;
                        design_count = 0;
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
    // same thing here, which is the point: the store, the crawl, the catalog
    // refresh and the page we serve peers all ask this one question.
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

    // A designer did not answer a call a live one would have. Returns true when
    // this is the strike that retires them, so the caller can say so once rather
    // than re-deriving it.
    //
    // Only the paid update routes are counted. A crawl query must never reach
    // here: a peer on the previous release exposes no query dispatcher at all,
    // and retiring them for not having upgraded yet would be a lie about the
    // one thing this flag claims to know.
    // Which backend-call failure is evidence about the peer rather than about
    // us. A rejection is their canister declining to run our dispatcher at all;
    // every other code the broker returns describes something that went wrong on
    // this side, and striking a designer for our own concurrency limit would be
    // unjust. An unreadable reply is not here either: that call was answered.
    public func strikeable(code : Text) : Bool {
        code == "call_rejected";
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
        if (retire) Map.remove(mem.catalog_cache, Principal.compare, canister);
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
        if (retire) Map.remove(mem.catalog_cache, Principal.compare, canister);
        true;
    };

    // Ignoring drops the cached catalog with the flag. We will never fetch this
    // designer again while they are ignored, so anything still cached could only
    // grow staler behind a row the owner has said they do not want; the store
    // reads the cache, so leaving it would leave them on display. Un-ignoring
    // therefore shows nothing until the next refresh, which is honest.
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
                if (ignore_) Map.remove(mem.catalog_cache, Principal.compare, canister);
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

    public func storeCatalog(
        mem : Memory.Mem,
        designer : Principal,
        designs : [Memory.CachedDesign],
        now : Int,
    ) : () {
        if (
            Map.get(mem.catalog_cache, Principal.compare, designer) == null and
            Map.size(mem.catalog_cache) >= MAX_CATALOG_CACHE
        ) evictCatalog(mem);
        Map.add(
            mem.catalog_cache,
            Principal.compare,
            designer,
            { designer; fetched_at_ns = now; designs },
        );
        switch (get(mem, designer)) {
            case (?existing) {
                Map.add(
                    mem.directory,
                    Principal.compare,
                    designer,
                    {
                        existing with
                        last_seen_ns = now;
                        last_catalog_ns = ?now;
                        design_count = designs.size();
                    },
                );
            };
            case null {};
        };
    };

    public type StoreFilter = {
        ownership : Text; // all | owned | not_owned
        designer_ownership : Text; // all | owner_of_designer | not_owner_of_designer
        policy : Text; // all | open | approval | requirements
        nsfw : Text; // hide | show
    };

    public type StoreRow = {
        designer : Principal;
        design_id : Nat;
        title : Text;
        art : Memory.Art;
        requirements : Memory.TradeRequirements;
        nsfw : Bool;
        design_revision : Nat;
        owned : Bool;
        owns_designer : Bool;
        fetched_at_ns : Int;
    };

    // `nsfw_hidden` counts what the tag filter removed, so a store that is
    // quietly smaller than the directory can say so rather than just look empty.
    public type StorePage = {
        rows : [StoreRow];
        total : Nat;
        nsfw_hidden : Nat;
    };

    public func validFilter(filter : StoreFilter) : Bool {
        let ownershipOk = filter.ownership == "all" or filter.ownership == "owned" or filter.ownership == "not_owned";
        let designerOk = filter.designer_ownership == "all" or filter.designer_ownership == "owner_of_designer" or filter.designer_ownership == "not_owner_of_designer";
        let policyOk = filter.policy == "all" or filter.policy == "open" or filter.policy == "approval" or filter.policy == "requirements";
        let nsfwOk = filter.nsfw == "hide" or filter.nsfw == "show";
        ownershipOk and designerOk and policyOk and nsfwOk;
    };

    // Filtering happens here rather than in the tile so that `total` and paging
    // stay correct for the filtered set.
    public func storeRows(
        mem : Memory.Mem,
        filter : StoreFilter,
        offset : Nat,
        limit : Nat,
    ) : StorePage {
        let catalogs = Array.sort<(Principal, Memory.CachedCatalog)>(
            Map.toArray(mem.catalog_cache),
            func(left, right) { Principal.compare(left.0, right.0) },
        );
        let matched = List.empty<StoreRow>();
        var hidden = 0;
        for ((designer, catalog) in catalogs.values()) {
            let ownsDesigner = Holdings.ownsAnyFrom(mem, designer);
            // Ignoring and retiring both empty the cache; this keeps the store
            // correct even if some other path caches a designer afterwards.
            if (reachable(mem, designer) and designerOwnershipMatches(filter, ownsDesigner)) {
                for (design in catalog.designs.values()) {
                    let owned = Holdings.ownsDesign(mem, designer, design.design_id);
                    if (
                        ownershipMatches(filter, owned) and
                        policyMatches(filter, design.requirements)
                    ) {
                        // Counted before it is dropped: the tag filter is the
                        // one axis whose omissions the owner did not pick row by
                        // row, so the tile is told how many it took away.
                        if (design.nsfw and filter.nsfw == "hide") {
                            hidden += 1;
                        } else {
                            List.add(
                                matched,
                                {
                                    designer;
                                    design_id = design.design_id;
                                    title = design.title;
                                    art = design.art;
                                    requirements = design.requirements;
                                    nsfw = design.nsfw;
                                    design_revision = design.design_revision;
                                    owned;
                                    owns_designer = ownsDesigner;
                                    fetched_at_ns = catalog.fetched_at_ns;
                                },
                            );
                        };
                    };
                };
            };
        };
        let all = List.toArray(matched);
        let total = all.size();
        if (offset >= total or limit == 0) return { rows = []; total; nsfw_hidden = hidden };
        let available : Nat = total - offset;
        let take = if (limit < available) limit else available;
        {
            rows = Array.tabulate<StoreRow>(take, func(i) { all[offset + i] });
            total;
            nsfw_hidden = hidden;
        };
    };

    func ownershipMatches(filter : StoreFilter, owned : Bool) : Bool {
        switch (filter.ownership) {
            case ("owned") owned;
            case ("not_owned") not owned;
            case (_) true;
        };
    };

    func designerOwnershipMatches(filter : StoreFilter, ownsDesigner : Bool) : Bool {
        switch (filter.designer_ownership) {
            case ("owner_of_designer") ownsDesigner;
            case ("not_owner_of_designer") not ownsDesigner;
            case (_) true;
        };
    };

    // "open" and "requirements" are not opposites: a design may ask for the
    // designer's approval and nothing else, which is neither.
    func policyMatches(filter : StoreFilter, requirements : Memory.TradeRequirements) : Bool {
        switch (filter.policy) {
            case ("open") Requirements.open(requirements);
            case ("approval") requirements.approval;
            case ("requirements") Requirements.restrictive(requirements);
            case (_) true;
        };
    };

    // Drop the least recently seen designer nothing protects. If every entry is
    // protected, the table simply stops growing.
    //
    // What is protected is every entry that represents a decision, and every
    // entry we would lose something by forgetting: a designer the owner typed in
    // or picked from Contacts, one we hold a chip from, and one that is ignored
    // or retired. The last two matter most now that a crawl can arrive with
    // hundreds of names at once — evicting a decision would let the very next
    // crawl reinstate the designer as though it had never been made.
    //
    // What is left to evict is what a crawl or a trade brought in on its own.
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
                Map.remove(mem.catalog_cache, Principal.compare, canister);
            };
            case null {};
        };
    };

    // An entry the owner put here on purpose, rather than one that arrived.
    func chosen(entry : Memory.DirectoryEntry) : Bool {
        switch (entry.source) {
            case (#manual or #contacts) true;
            case (#trade or #crawl) false;
        };
    };

    func evictCatalog(mem : Memory.Mem) : () {
        var victim : ?(Principal, Int) = null;
        for ((designer, catalog) in Map.entries(mem.catalog_cache)) {
            switch (victim) {
                case (?(_, fetched)) {
                    if (catalog.fetched_at_ns < fetched) {
                        victim := ?(designer, catalog.fetched_at_ns);
                    };
                };
                case null victim := ?(designer, catalog.fetched_at_ns);
            };
        };
        switch (victim) {
            case (?(designer, _)) Map.remove(mem.catalog_cache, Principal.compare, designer);
            case null {};
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

    // Cached catalog lookup used when proposing a trade.
    public func cachedDesign(
        mem : Memory.Mem,
        designer : Principal,
        designId : Nat,
    ) : ?Memory.CachedDesign {
        let ?catalog = Map.get(mem.catalog_cache, Principal.compare, designer) else return null;
        for (design in catalog.designs.values()) {
            if (design.design_id == designId) return ?design;
        };
        null;
    };

    // Text form used by tile payloads and log-free error codes.
    public func sourceText(source : Memory.DirectorySource) : Text {
        switch (source) {
            case (#manual) "manual";
            case (#contacts) "contacts";
            case (#trade) "trade";
            case (#crawl) "crawl";
        };
    };

    public func natText(value : Nat) : Text = Nat.toText(value);

    public func textCompare(left : Text, right : Text) : { #less; #equal; #greater } = Text.compare(left, right);
}
