import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Holdings "./Holdings";
import Memory "./memory/chipswap/v1";

// The designer directory and the cached catalogs the store reads from.
//
// Learning about a designer never publishes us to them: `announce` is a separate
// owner decision, so `announced` stays false until the owner acts (or the
// auto-announce setting does it for them).
module {
    public let MAX_DIRECTORY : Nat = 512;
    public let MAX_SHARE : Nat = 32;
    public let MAX_CATALOG_CACHE : Nat = 32;

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
                        announced = false;
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

    // Merge a peer's shared directory. Bounded by MAX_SHARE so one exchange
    // cannot flood the table, and never adds us.
    public func merge(
        mem : Memory.Mem,
        entries : [Principal],
        self : Principal,
        now : Int,
    ) : Nat {
        var added = 0;
        var considered = 0;
        for (candidate in entries.values()) {
            if (considered >= MAX_SHARE) return added;
            if (not Principal.equal(candidate, self)) {
                considered += 1;
                if (note(mem, candidate, #exchange, now)) added += 1;
            };
        };
        added;
    };

    public func markAnnounced(mem : Memory.Mem, canister : Principal, now : Int) : () {
        switch (get(mem, canister)) {
            case (?existing) {
                Map.add(
                    mem.directory,
                    Principal.compare,
                    canister,
                    { existing with announced = true; last_seen_ns = now },
                );
            };
            case null {};
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

    // Most recently seen peers first: those are the ones a counterpart is most
    // likely to be able to reach.
    public func share(mem : Memory.Mem, self : Principal, limit : Nat) : [Principal] {
        if (limit == 0) return [];
        let cap = if (limit < MAX_SHARE) limit else MAX_SHARE;
        let entries = Array.sort<(Principal, Memory.DirectoryEntry)>(
            Map.toArray(mem.directory),
            func(left, right) {
                switch (Int.compare(right.1.last_seen_ns, left.1.last_seen_ns)) {
                    case (#equal) Principal.compare(left.0, right.0);
                    case (order) order;
                };
            },
        );
        let picked = List.empty<Principal>();
        for ((canister, _) in entries.values()) {
            if (List.size(picked) < cap and not Principal.equal(canister, self)) {
                List.add(picked, canister);
            };
        };
        List.toArray(picked);
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
        trade_mode : Text; // all | auto | manual
    };

    public type StoreRow = {
        designer : Principal;
        design_id : Nat;
        title : Text;
        art : Memory.Art;
        trade_mode : Memory.TradeMode;
        design_revision : Nat;
        owned : Bool;
        owns_designer : Bool;
        fetched_at_ns : Int;
    };

    public type StorePage = {
        rows : [StoreRow];
        total : Nat;
    };

    public func validFilter(filter : StoreFilter) : Bool {
        let ownershipOk = filter.ownership == "all" or filter.ownership == "owned" or filter.ownership == "not_owned";
        let designerOk = filter.designer_ownership == "all" or filter.designer_ownership == "owner_of_designer" or filter.designer_ownership == "not_owner_of_designer";
        let modeOk = filter.trade_mode == "all" or filter.trade_mode == "auto" or filter.trade_mode == "manual";
        ownershipOk and designerOk and modeOk;
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
        for ((designer, catalog) in catalogs.values()) {
            let ownsDesigner = Holdings.ownsAnyFrom(mem, designer);
            if (designerOwnershipMatches(filter, ownsDesigner)) {
                for (design in catalog.designs.values()) {
                    let owned = Holdings.ownsDesign(mem, designer, design.design_id);
                    if (
                        ownershipMatches(filter, owned) and
                        tradeModeMatches(filter, design.trade_mode)
                    ) {
                        List.add(
                            matched,
                            {
                                designer;
                                design_id = design.design_id;
                                title = design.title;
                                art = design.art;
                                trade_mode = design.trade_mode;
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
        let all = List.toArray(matched);
        let total = all.size();
        if (offset >= total or limit == 0) return { rows = []; total };
        let available : Nat = total - offset;
        let take = if (limit < available) limit else available;
        {
            rows = Array.tabulate<StoreRow>(take, func(i) { all[offset + i] });
            total;
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

    func tradeModeMatches(filter : StoreFilter, mode : Memory.TradeMode) : Bool {
        switch (filter.trade_mode) {
            case ("auto") mode == #auto;
            case ("manual") mode == #manual;
            case (_) true;
        };
    };

    // Drop the least recently seen peer we neither announced to nor hold a chip
    // from. If every entry is protected, the table simply stops growing.
    func evictOne(mem : Memory.Mem) : () {
        var victim : ?(Principal, Int) = null;
        for ((canister, entry) in Map.entries(mem.directory)) {
            if (not entry.announced and not Holdings.ownsAnyFrom(mem, canister)) {
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
            case (#announce) "announce";
            case (#exchange) "exchange";
        };
    };

    public func natText(value : Nat) : Text = Nat.toText(value);

    public func textCompare(left : Text, right : Text) : { #less; #equal; #greater } = Text.compare(left, right);
}
