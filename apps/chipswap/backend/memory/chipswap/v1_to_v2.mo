import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import V1 "./v1";
import V2 "./v2";

// V1's trade mode carried exactly one requirement, so the conversion is exact:
// `#manual` asked the designer to approve every trade, and `#auto` asked for
// nothing at all. Neither said anything about the artwork, so no design comes
// out of the migration refusing an offer it used to accept.
//
// Nothing in V1 recorded an NSFW tag, so every design and every chip already in
// a collection arrives untagged. A designer may tag their own designs
// afterwards; a chip someone else minted keeps the label it was handed over
// with, which for a V1 chip is none.
module {
    public func migrate(old : V1.Mem) : V2.Mem {
        let designs = Map.empty<Nat, V2.Design>();
        for ((id, design) in Map.entries(old.designs)) {
            Map.add(designs, Nat.compare, id, convertDesign(design));
        };

        let holdings = Map.empty<Text, V2.Chip>();
        for ((key, chip) in Map.entries(old.holdings)) {
            Map.add(holdings, Text.compare, key, convertChip(chip));
        };

        let directory = Map.empty<Principal, V2.DirectoryEntry>();
        for ((canister, entry) in Map.entries(old.directory)) {
            Map.add(directory, Principal.compare, canister, convertEntry(entry));
        };

        let catalogCache = Map.empty<Principal, V2.CachedCatalog>();
        for ((designer, catalog) in Map.entries(old.catalog_cache)) {
            Map.add(
                catalogCache,
                Principal.compare,
                designer,
                {
                    designer = catalog.designer;
                    fetched_at_ns = catalog.fetched_at_ns;
                    designs = Array.map<V1.CachedDesign, V2.CachedDesign>(
                        catalog.designs,
                        convertCachedDesign,
                    );
                } : V2.CachedCatalog,
            );
        };

        let incoming = Map.empty<Text, V2.IncomingTrade>();
        for ((key, trade) in Map.entries(old.incoming)) {
            Map.add(
                incoming,
                Text.compare,
                key,
                {
                    request_id = trade.request_id;
                    peer = trade.peer;
                    want_design_id = trade.want_design_id;
                    offered = convertChip(trade.offered);
                    state = convertIncomingState(trade.state);
                    received_at_ns = trade.received_at_ns;
                    updated_at_ns = trade.updated_at_ns;
                } : V2.IncomingTrade,
            );
        };

        let outgoing = Map.empty<Text, V2.OutgoingTrade>();
        for ((key, trade) in Map.entries(old.outgoing)) {
            Map.add(
                outgoing,
                Text.compare,
                key,
                {
                    request_id = trade.request_id;
                    peer = trade.peer;
                    want_design_id = trade.want_design_id;
                    offered_key = trade.offered_key;
                    offered_ref = convertRef(trade.offered_ref);
                    offered_title = trade.offered_title;
                    state = convertOutgoingState(trade.state);
                    created_at_ns = trade.created_at_ns;
                    updated_at_ns = trade.updated_at_ns;
                } : V2.OutgoingTrade,
            );
        };

        let replay = Map.empty<Text, V2.ReplayRecord>();
        for ((key, record) in Map.entries(old.replay)) {
            Map.add(
                replay,
                Text.compare,
                key,
                {
                    request_id = record.request_id;
                    peer = record.peer;
                    outcome = convertReplayOutcome(record.outcome);
                    recorded_at_ns = record.recorded_at_ns;
                } : V2.ReplayRecord,
            );
        };

        let brushes = List.empty<V2.CustomBrush>();
        for (brush in List.values(old.brushes)) {
            List.add(
                brushes,
                {
                    id = brush.id;
                    name = brush.name;
                    width = brush.width;
                    height = brush.height;
                    anchor_x = brush.anchor_x;
                    anchor_y = brush.anchor_y;
                    cells = brush.cells;
                } : V2.CustomBrush,
            );
        };

        {
            var revision = old.revision;
            var next_request_seq = old.next_request_seq;
            var next_brush_id = old.next_brush_id;
            var settings = { auto_announce = old.settings.auto_announce };
            designs;
            holdings;
            directory;
            catalog_cache = catalogCache;
            incoming;
            outgoing;
            replay;
            brushes;
        };
    };

    // The whole of the policy change: a mode becomes the one requirement it
    // stood for, and nothing else is asked of an offer.
    public func convertRequirements(mode : V1.TradeMode) : V2.TradeRequirements {
        {
            V2.openRequirements() with
            approval = switch (mode) { case (#auto) false; case (#manual) true }
        };
    };

    func convertArt(art : V1.Art) : V2.Art {
        {
            shape_id = art.shape_id;
            palette = art.palette;
            pixels = art.pixels;
        };
    };

    func convertDesign(design : V1.Design) : V2.Design {
        {
            design_id = design.design_id;
            title = design.title;
            art = convertArt(design.art);
            state = switch (design.state) {
                case (#draft) #draft;
                case (#published) #published;
            };
            requirements = convertRequirements(design.trade_mode);
            nsfw = false;
            revision = design.revision;
            created_at_ns = design.created_at_ns;
            published_at_ns = design.published_at_ns;
            next_serial = design.next_serial;
        };
    };

    func convertCachedDesign(design : V1.CachedDesign) : V2.CachedDesign {
        {
            design_id = design.design_id;
            title = design.title;
            art = convertArt(design.art);
            requirements = convertRequirements(design.trade_mode);
            nsfw = false;
            design_revision = design.design_revision;
            published_at_ns = design.published_at_ns;
        };
    };

    func convertRef(ref : V1.ChipRef) : V2.ChipRef {
        {
            designer = ref.designer;
            design_id = ref.design_id;
            serial = ref.serial;
        };
    };

    func convertChip(chip : V1.Chip) : V2.Chip {
        {
            ref = convertRef(chip.ref);
            title = chip.title;
            art = convertArt(chip.art);
            nsfw = false;
            design_revision = chip.design_revision;
            minted_at_ns = chip.minted_at_ns;
            acquired_at_ns = chip.acquired_at_ns;
            state = switch (chip.state) {
                case (#held) #held;
                case (#escrowed(payload)) #escrowed(payload);
                case (#uncertain(payload)) #uncertain(payload);
            };
        };
    };

    func convertEntry(entry : V1.DirectoryEntry) : V2.DirectoryEntry {
        {
            canister = entry.canister;
            source = switch (entry.source) {
                case (#manual) #manual;
                case (#contacts) #contacts;
                case (#trade) #trade;
                case (#announce) #announce;
                case (#exchange) #exchange;
            };
            first_seen_ns = entry.first_seen_ns;
            last_seen_ns = entry.last_seen_ns;
            announced = entry.announced;
            last_catalog_ns = entry.last_catalog_ns;
            design_count = entry.design_count;
        };
    };

    func convertIncomingState(state : V1.IncomingState) : V2.IncomingState {
        switch (state) {
            case (#pending) #pending;
            case (#accepted(payload)) #accepted({ payload with nsfw = false });
            case (#declined) #declined;
        };
    };

    func convertOutgoingState(state : V1.OutgoingState) : V2.OutgoingState {
        switch (state) {
            case (#sending) #sending;
            case (#pending_designer) #pending_designer;
            case (#completed(ref)) #completed(convertRef(ref));
            case (#declined(reason)) #declined(reason);
            case (#failed(reason)) #failed(reason);
            case (#uncertain) #uncertain;
        };
    };

    func convertReplayOutcome(outcome : V1.ReplayOutcome) : V2.ReplayOutcome {
        switch (outcome) {
            case (#minted(payload)) #minted({ payload with nsfw = false });
            case (#pending) #pending;
            case (#declined(reason)) #declined(reason);
        };
    };
};
