import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import NeutronCapabilities "mo:neutron-capabilities";
import Designs "./Designs";
import Directory "./Directory";
import Holdings "./Holdings";
import IngressWire "./IngressWire";
import Memory "./memory/chipswap/v5";
import PrincipalText "./PrincipalText";
import Requirements "./Requirements";
import Shape "./Shape";
import Trades "./Trades";
import Wire "./Wire";

// Chipswap: design pixel chips, publish up to ten of them, and trade with other
// Neutron canisters.
//
// Every type reachable from a public method is declared here and concrete. The
// kernel's method-schema generator resolves local aliases but cannot follow an
// imported module alias, so service modules return structurally identical
// records and Motoko's structural typing keeps the two in step.
module {
    public type NeutronContactMatchV2 = {
        contact_id : Nat;
        contact_revision : Nat;
        contact_name : Text;
        principal : Principal;
    };

    public type NeutronContactLookupV2 = {
        book_revision : Nat;
        integrity_ok : Bool;
        match : ?NeutronContactMatchV2;
    };

    public type DiscoverNeutronContactsRequestV2 = {
        search_text : Text;
        offset : Nat;
        limit : Nat;
    };

    public type DiscoverNeutronContactsPageV2 = {
        book_revision : Nat;
        contacts : [NeutronContactMatchV2];
        total : Nat;
        next_offset : ?Nat;
    };

    public type ContactErrorV2 = {
        #validation : Text;
        #not_found : Nat;
        #conflict : { expected : Nat; actual : Nat };
        #neutron_conflict : {
            principal : Principal;
            contact_id : Nat;
            contact_name : Text;
        };
        #limit : Text;
    };

    public type DiscoverNeutronContactsResultV2 = {
        #ok : DiscoverNeutronContactsPageV2;
        #err : ContactErrorV2;
    };

    public type AppCalls = {
        contacts : {
            contacts_neutron_lookup_v2 : {
                principal : Principal;
            } -> NeutronContactLookupV2;
            contacts_neutron_search_v2 : DiscoverNeutronContactsRequestV2 -> DiscoverNeutronContactsResultV2;
        };
    };

    public type AppBackendEnvironment = {
        stable_memory : { chipswap : Memory.Mem };
        app_calls : AppCalls;
        capabilities : {
            backend_calls : NeutronCapabilities.BackendCallsV1;
        };
    };

    // --- Owner-facing views -------------------------------------------------

    public type Err = { code : Text; message : Text };

    public type ArtView = {
        shape_id : Text;
        palette : [Text];
        pixels : Text;
    };

    // `nsfw` is the rule the designer set — "any", "disallowed", or "required"
    // — as text rather than an optional variant, so the whole view stays flat,
    // which is what the tile's parsers expect.
    public type RequirementsView = {
        approval : Bool;
        min_colors : ?Nat;
        max_coverage : ?Nat;
        nsfw : Text;
    };

    public type DesignView = {
        design_id : Nat;
        title : Text;
        art : ArtView;
        state : Text;
        requirements : RequirementsView;
        nsfw : Bool;
        revision : Nat;
        created_at_ns : Int;
        published_at_ns : ?Int;
        minted_count : Nat;
    };

    // `origin` is "held" for a chip that came in through a trade and "design"
    // for one of our own published designs, which the collection carries even
    // though it is not a holding. A "design" row has no serial and no trade to
    // settle; `minted_count` is how many of it are out in the world, and is 0
    // on anything held.
    public type ChipView = {
        key : Text;
        designer : Text;
        design_id : Nat;
        serial : Nat;
        title : Text;
        art : ArtView;
        nsfw : Bool;
        design_revision : Nat;
        minted_at_ns : Int;
        acquired_at_ns : Int;
        state : Text;
        peer : ?Text;
        request_id : ?Text;
        contact_name : ?Text;
        origin : Text;
        minted_count : Nat;
    };

    public type StatusView = {
        revision : Nat;
        canister : Text;
        slots_used : Nat;
        slot_limit : Nat;
        draft_count : Nat;
        published_count : Nat;
        holdings : Nat;
        holdings_limit : Nat;
        directory_count : Nat;
        catalog_designers : Nat;
        incoming_pending : Nat;
        outgoing_active : Nat;
        crawl : CrawlView;
        shape_id : Text;
        pixel_count : Nat;
        row_widths : [Nat];
        palette_limit : Nat;
        contacts_available : Bool;
    };

    public type CollectionPage = {
        chips : [ChipView];
        total : Nat;
    };

    public type DirectoryEntryView = {
        canister : Text;
        source : Text;
        first_seen_ns : Int;
        last_seen_ns : Int;
        ignored : Bool;
        retired : Bool;
        strikes : Nat;
        last_catalog_ns : ?Int;
        design_count : Nat;
        owns_chip : Bool;
        contact_name : ?Text;
    };

    // What the tile needs to draw a crawl: whether one is running, how far it
    // has got, and how much of the directory it has still to ask.
    public type CrawlView = {
        active : Bool;
        queried : Nat;
        discovered : Nat;
        remaining : Nat;
        full : Bool;
    };

    public type DirectoryPage = {
        entries : [DirectoryEntryView];
        total : Nat;
    };

    public type StoreRowView = {
        designer : Text;
        design_id : Nat;
        title : Text;
        art : ArtView;
        requirements : RequirementsView;
        nsfw : Bool;
        design_revision : Nat;
        owned : Bool;
        fetched_at_ns : Int;
        contact_name : ?Text;
    };

    public type StorePage = {
        rows : [StoreRowView];
        total : Nat;
        nsfw_hidden : Nat;
    };

    public type IncomingTradeView = {
        request_id : Text;
        peer : Text;
        want_design_id : Nat;
        want_title : Text;
        offered : ChipView;
        state : Text;
        received_at_ns : Int;
        updated_at_ns : Int;
        contact_name : ?Text;
    };

    public type OutgoingTradeView = {
        request_id : Text;
        peer : Text;
        want_design_id : Nat;
        offered_designer : Text;
        offered_design_id : Nat;
        offered_serial : Nat;
        offered_title : Text;
        offered_key : ?Text;
        state : Text;
        detail : ?Text;
        created_at_ns : Int;
        updated_at_ns : Int;
        contact_name : ?Text;
    };

    public type TradesView = {
        incoming : [IncomingTradeView];
        outgoing : [OutgoingTradeView];
    };

    public type BrushView = {
        id : Nat;
        name : Text;
        width : Nat;
        height : Nat;
        anchor_x : Nat;
        anchor_y : Nat;
        cells : Text;
    };

    public type SuggestionView = {
        contact_name : Text;
        principal : Text;
        in_directory : Bool;
    };

    public type SuggestionPage = {
        rows : [SuggestionView];
        total : Nat;
        available : Bool;
    };

    public type RevisionResult = {
        #ok : { revision : Nat };
        #err : Err;
    };

    public type CreateDesignResult = {
        #ok : { design_id : Nat; revision : Nat };
        #err : Err;
    };

    public type TradeActionResult = {
        #ok : { request_id : Text; outcome : Text; revision : Nat };
        #err : Err;
    };

    public type FetchCatalogsResult = {
        #ok : { fetched : [Text]; failed : [Text]; revision : Nat };
        #err : Err;
    };

    public type CrawlResult = {
        #ok : CrawlView;
        #err : Err;
    };

    // --- Owner-facing requests ---------------------------------------------

    public type PageRequest = { offset : Nat; limit : Nat };

    public type DesignRequest = { design_id : Nat };

    public type CreateDraftRequest = { title : Text };

    public type SaveDraftRequest = {
        design_id : Nat;
        expected_revision : Nat;
        title : Text;
        palette : [Text];
        pixels : Text;
    };

    // The requirement fields are spelled out rather than nested so publishing
    // and re-policying take the same shape, and so an omitted requirement is a
    // null rather than a sentinel number.
    public type PublishRequest = {
        design_id : Nat;
        expected_revision : Nat;
        approval : Bool;
        min_colors : ?Nat;
        max_coverage : ?Nat;
        nsfw_rule : Text;
        nsfw : Bool;
    };

    public type TradePolicyRequest = {
        design_id : Nat;
        approval : Bool;
        min_colors : ?Nat;
        max_coverage : ?Nat;
        nsfw_rule : Text;
        nsfw : Bool;
    };

    public type DirectoryAddRequest = { canister : Text; source : Text };

    public type CanisterRequest = { canister : Text };

    public type IgnoreRequest = { canister : Text; ignored : Bool };

    public type RetireRequest = { canister : Text; retired : Bool };

    // `designer` is a principal as text, and empty means every designer. It
    // crosses as text rather than a principal because the tile reads it out of
    // a select whose empty option is a string like every other option.
    public type StoreRequest = {
        ownership : Text;
        nsfw : Text;
        requirements : [Text];
        designer : Text;
        search : Text;
        sort : Text;
        offset : Nat;
        limit : Nat;
    };

    public type SaveBrushRequest = {
        id : ?Nat;
        name : Text;
        width : Nat;
        height : Nat;
        anchor_x : Nat;
        anchor_y : Nat;
        cells : Text;
    };

    public type BrushRequest = { id : Nat };

    public type FetchCatalogsRequest = { canisters : [Text] };

    public type ProposeTradeRequest = {
        peer : Text;
        want_design_id : Nat;
        offer_kind : Text;
        offer_design_id : ?Nat;
        offer_chip_key : ?Text;
    };

    public type TradeRequestRef = { request_id : Text };

    public type SuggestionRequest = {
        search_text : Text;
        offset : Nat;
        limit : Nat;
    };

    // --- Peer protocol requests (decoded by the kernel before dispatch) -----

    public type PeerArt = {
        shape_id : Text;
        palette : [Nat32];
        pixels : Blob;
    };

    public type PeerChip = {
        designer : Principal;
        design_id : Nat;
        serial : Nat;
        title : Text;
        art : PeerArt;
        nsfw : Bool;
        design_revision : Nat;
        minted_at_ns : Int;
    };

    // A catalog read asks for nothing but the catalog. It used to carry a
    // directory, and the reply used to carry one back; discovery is its own
    // request now.
    public type PeerCatalogRequest = {};

    public type PeerTradeRequest = {
        request_id : Blob;
        want_design_id : Nat;
        offered : PeerChip;
    };

    public type PeerDeliverOutcome = {
        #minted : PeerChip;
        #returned : PeerChip;
        #declined;
    };

    public type PeerDeliverRequest = {
        request_id : Blob;
        outcome : PeerDeliverOutcome;
    };

    public type PeerStatusRequest = { request_id : Blob };

    // One page of a peer's directory. The reply says how many entries the peer
    // has in total, so a crawler knows whether to ask for the next page.
    public type PeerDirectoryRequest = { offset : Nat; limit : Nat };

    // --- Protocol constants -------------------------------------------------

    let INGRESS_METHOD : Text = "app_chipswap__chipswap_v1_update";
    // A query route is reached through a different physical method from the
    // update one: a query dispatcher and an update dispatcher are separate
    // entry points, not two moods of the same one.
    let INGRESS_QUERY_METHOD : Text = "app_chipswap__chipswap_v1_query";
    let ROUTE_CATALOG : Text = "catalog";
    let ROUTE_TRADE : Text = "trade";
    let ROUTE_DELIVER : Text = "deliver";
    let ROUTE_STATUS : Text = "status";
    let ROUTE_DIRECTORY : Text = "directory";

    // Each floor matches capabilities.public_ingress in neutron.json. The sender
    // pays for the work and storage it asks a peer to perform.
    let TRADE_CYCLES : Nat = 600_000_000;
    let DELIVER_CYCLES : Nat = 600_000_000;
    let STATUS_CYCLES : Nat = 200_000_000;
    // A query route declares no floor and can accept nothing, so reading a
    // peer's catalog or crawling their directory attaches nothing and costs
    // them nothing.
    let QUERY_ROUTE_CYCLES : Nat = 0;

    let CANDID_SLACK : Nat = 64;
    let MAX_FETCH_TARGETS : Nat = 8;
    // One crawl step, bounded by the same concurrency the manifest declares.
    let MAX_CRAWL_TARGETS : Nat = 8;
    let CRAWL_PAGE : Nat = 128;
    let MAX_DIRECTORY_REPLY_BYTES : Nat = 8_192;
    let MAX_BRUSH_CELLS : Nat = 49;
    let MAX_BRUSHES : Nat = 16;
    let MAX_BRUSH_NAME_CHARS : Nat = 24;

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.chipswap;
        let appCalls = env.app_calls;
        let calls = env.capabilities.backend_calls;
        let self = calls.canister_principal;

        // Runs on install and on every upgrade, and is a no-op after the first:
        // the only way this canister's own address reaches the directory is the
        // seed of a clean install landing on the seeded canister.
        ignore Directory.dropSelf(mem, self);

        // --- Queries --------------------------------------------------------

        public func /*query*/chipswap_status(()) : StatusView {
            var drafts = 0;
            var published = 0;
            for ((_, design) in Map.entries(mem.designs)) {
                switch (design.state) {
                    case (#draft) drafts += 1;
                    case (#published) published += 1;
                };
            };
            var incoming = 0;
            for ((_, trade) in Map.entries(mem.incoming)) {
                if (trade.state == #pending) incoming += 1;
            };
            var outgoing = 0;
            for ((_, trade) in Map.entries(mem.outgoing)) {
                if (activeOutgoing(trade.state)) outgoing += 1;
            };
            {
                revision = mem.revision;
                canister = Principal.toText(self);
                slots_used = Designs.slotsUsed(mem);
                slot_limit = Designs.MAX_SLOTS;
                draft_count = drafts;
                published_count = published;
                holdings = Holdings.count(mem);
                holdings_limit = Holdings.MAX_HOLDINGS;
                directory_count = Map.size(mem.directory);
                catalog_designers = Map.size(mem.catalog_cache);
                incoming_pending = incoming;
                outgoing_active = outgoing;
                crawl = crawlView();
                shape_id = Shape.SHAPE_ID;
                pixel_count = Shape.PIXEL_COUNT;
                row_widths = Shape.ROW_WIDTHS;
                palette_limit = Shape.MAX_PALETTE;
                contacts_available = contactsAvailable();
            };
        };

        public func /*query*/chipswap_designs(()) : [DesignView] {
            let entries = Array.sort<(Nat, Memory.Design)>(
                Map.toArray(mem.designs),
                func(left, right) { Nat.compare(left.0, right.0) },
            );
            Array.map<(Nat, Memory.Design), DesignView>(
                entries,
                func(entry) { designView(entry.1) },
            );
        };

        public func /*query*/chipswap_design(request : DesignRequest) : ?DesignView {
            switch (Designs.get(mem, request.design_id)) {
                case (?design) ?designView(design);
                case null null;
            };
        };

        // Our own published designs lead the collection, in slot order, ahead of
        // everything we collected. They are not holdings — publishing spends no
        // slot and mints nothing for us — so they are read straight off
        // `mem.designs` here rather than stored, which is also why a design
        // published before this existed shows up without a migration. Drafts
        // stay out: `Designs.published` filters them, and a design nobody could
        // hold is not a chip.
        public func /*query*/chipswap_collection(request : PageRequest) : CollectionPage {
            let limit = boundedLimit(request.limit);
            let designs = Designs.published(mem);
            let leading : Nat = if (request.offset < designs.size()) {
                let available : Nat = designs.size() - request.offset;
                if (limit < available) limit else available;
            } else 0;
            // Holdings resume where the designs left off, so one window can
            // straddle the two and neither is ever skipped.
            let heldOffset : Nat = if (request.offset > designs.size()) {
                request.offset - designs.size();
            } else 0;
            let held = Holdings.page(mem, heldOffset, limit - leading);
            {
                chips = Array.tabulate<ChipView>(
                    leading + held.chips.size(),
                    func(i) {
                        if (i < leading) designChipView(designs[request.offset + i]) else chipView(
                            held.chips[i - leading]
                        );
                    },
                );
                total = designs.size() + held.total;
            };
        };

        public func /*query*/chipswap_directory(request : PageRequest) : DirectoryPage {
            let page = Directory.page(mem, request.offset, boundedLimit(request.limit));
            {
                entries = Array.map<Memory.DirectoryEntry, DirectoryEntryView>(
                    page.entries,
                    func(entry) {
                        {
                            canister = Principal.toText(entry.canister);
                            source = Directory.sourceText(entry.source);
                            first_seen_ns = entry.first_seen_ns;
                            last_seen_ns = entry.last_seen_ns;
                            ignored = entry.ignored;
                            retired = entry.retired;
                            strikes = entry.strikes;
                            last_catalog_ns = entry.last_catalog_ns;
                            design_count = entry.design_count;
                            owns_chip = Holdings.ownsAnyFrom(mem, entry.canister);
                            contact_name = contactName(entry.canister);
                        };
                    },
                );
                total = page.total;
            };
        };

        public func /*query*/chipswap_store(request : StoreRequest) : StorePage {
            let empty = { rows = []; total = 0; nsfw_hidden = 0 };
            // No designer picked is an empty string. Anything else has to be a
            // principal we can compare against, so text that is not one narrows
            // the market to nothing rather than quietly widening it to
            // everything.
            let designer : ?Principal = if (request.designer == "") null else {
                switch (PrincipalText.parse(request.designer)) {
                    case (?value) ?value;
                    case null return empty;
                };
            };
            let filter = {
                ownership = request.ownership;
                nsfw = request.nsfw;
                requirements = request.requirements;
                designer;
                search = request.search;
                sort = request.sort;
            };
            if (not Directory.validFilter(filter)) return empty;
            let page = Directory.storeRows(
                mem,
                filter,
                request.offset,
                boundedLimit(request.limit),
            );
            {
                rows = Array.map<Directory.StoreRow, StoreRowView>(
                    page.rows,
                    func(row) {
                        {
                            designer = Principal.toText(row.designer);
                            design_id = row.design_id;
                            title = row.title;
                            art = artView(row.art);
                            requirements = requirementsView(row.requirements);
                            nsfw = row.nsfw;
                            design_revision = row.design_revision;
                            owned = row.owned;
                            fetched_at_ns = row.fetched_at_ns;
                            contact_name = contactName(row.designer);
                        };
                    },
                );
                total = page.total;
                nsfw_hidden = page.nsfw_hidden;
            };
        };

        public func /*query*/chipswap_trades(()) : TradesView {
            {
                incoming = Array.map<Memory.IncomingTrade, IncomingTradeView>(
                    Trades.pendingIncoming(mem),
                    func(trade) {
                        {
                            request_id = Trades.hex(trade.request_id);
                            peer = Principal.toText(trade.peer);
                            want_design_id = trade.want_design_id;
                            want_title = designTitle(trade.want_design_id);
                            offered = chipView(trade.offered);
                            state = incomingStateText(trade.state);
                            received_at_ns = trade.received_at_ns;
                            updated_at_ns = trade.updated_at_ns;
                            contact_name = contactName(trade.peer);
                        };
                    },
                );
                outgoing = Array.map<Memory.OutgoingTrade, OutgoingTradeView>(
                    Trades.pendingOutgoing(mem),
                    func(trade) {
                        let (state, detail) = outgoingStateText(trade.state);
                        {
                            request_id = Trades.hex(trade.request_id);
                            peer = Principal.toText(trade.peer);
                            want_design_id = trade.want_design_id;
                            offered_designer = Principal.toText(trade.offered_ref.designer);
                            offered_design_id = trade.offered_ref.design_id;
                            offered_serial = trade.offered_ref.serial;
                            offered_title = trade.offered_title;
                            offered_key = trade.offered_key;
                            state;
                            detail;
                            created_at_ns = trade.created_at_ns;
                            updated_at_ns = trade.updated_at_ns;
                            contact_name = contactName(trade.peer);
                        };
                    },
                );
            };
        };

        public func /*query*/chipswap_brushes(()) : [BrushView] {
            Array.map<Memory.CustomBrush, BrushView>(
                List.toArray(mem.brushes),
                func(brush) {
                    {
                        id = brush.id;
                        name = brush.name;
                        width = brush.width;
                        height = brush.height;
                        anchor_x = brush.anchor_x;
                        anchor_y = brush.anchor_y;
                        cells = Trades.hex(brush.cells);
                    };
                },
            );
        };

        // Contacts is a declared install-time dependency, so this is a plain
        // synchronous call into the installed address book.
        public func /*query*/chipswap_contacts_suggestions(
            request : SuggestionRequest
        ) : SuggestionPage {
            switch (
                appCalls.contacts.contacts_neutron_search_v2({
                    search_text = request.search_text;
                    offset = request.offset;
                    limit = boundedLimit(request.limit);
                })
            ) {
                case (#err(_)) { { rows = []; total = 0; available = false } };
                case (#ok(page)) {
                    {
                        rows = Array.map<NeutronContactMatchV2, SuggestionView>(
                            page.contacts,
                            func(match) {
                                {
                                    contact_name = match.contact_name;
                                    principal = Principal.toText(match.principal);
                                    in_directory = Directory.get(mem, match.principal) != null;
                                };
                            },
                        );
                        total = page.total;
                        available = true;
                    };
                };
            };
        };

        // --- Design lifecycle ------------------------------------------------

        public func /*update*/chipswap_draft_create(
            request : CreateDraftRequest
        ) : CreateDesignResult {
            switch (Designs.create(mem, request.title, Time.now())) {
                case (#err(code)) #err(error(code));
                case (#ok(designId)) {
                    bump();
                    #ok({ design_id = designId; revision = mem.revision });
                };
            };
        };

        public func /*update*/chipswap_draft_save(
            request : SaveDraftRequest
        ) : RevisionResult {
            let palette = switch (parsePalette(request.palette)) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            let pixels = switch (parsePixels(request.pixels)) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            switch (
                Designs.save(
                    mem,
                    request.design_id,
                    request.expected_revision,
                    request.title,
                    palette,
                    pixels,
                )
            ) {
                case (#err(code)) #err(error(code));
                case (#ok(_)) {
                    bump();
                    #ok({ revision = mem.revision });
                };
            };
        };

        public func /*update*/chipswap_draft_delete(
            request : DesignRequest
        ) : RevisionResult {
            switch (Designs.delete(mem, request.design_id)) {
                case (#err(code)) #err(error(code));
                case (#ok(())) {
                    bump();
                    #ok({ revision = mem.revision });
                };
            };
        };

        public func /*update*/chipswap_publish(request : PublishRequest) : RevisionResult {
            let requirements = switch (
                parseRequirements(
                    request.approval,
                    request.min_colors,
                    request.max_coverage,
                    request.nsfw_rule,
                )
            ) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            switch (
                Designs.publish(
                    mem,
                    request.design_id,
                    request.expected_revision,
                    requirements,
                    request.nsfw,
                    Time.now(),
                )
            ) {
                case (#err(code)) #err(error(code));
                case (#ok(())) {
                    bump();
                    #ok({ revision = mem.revision });
                };
            };
        };

        public func /*update*/chipswap_set_trade_policy(
            request : TradePolicyRequest
        ) : RevisionResult {
            let requirements = switch (
                parseRequirements(
                    request.approval,
                    request.min_colors,
                    request.max_coverage,
                    request.nsfw_rule,
                )
            ) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            switch (
                Designs.setTradePolicy(mem, request.design_id, requirements, request.nsfw)
            ) {
                case (#err(code)) #err(error(code));
                case (#ok(())) {
                    bump();
                    #ok({ revision = mem.revision });
                };
            };
        };

        // --- Directory -------------------------------------------------------

        public func /*update*/chipswap_directory_add(
            request : DirectoryAddRequest
        ) : RevisionResult {
            let canister = switch (parsePrincipal(request.canister)) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            if (Principal.equal(canister, self)) return #err(error("self_entry"));
            let source : Memory.DirectorySource = switch (request.source) {
                case ("contacts") #contacts;
                case (_) #manual;
            };
            ignore Directory.note(mem, canister, source, Time.now());
            bump();
            #ok({ revision = mem.revision });
        };

        public func /*update*/chipswap_directory_remove(
            request : CanisterRequest
        ) : RevisionResult {
            let canister = switch (parsePrincipal(request.canister)) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            if (not Directory.remove(mem, canister)) return #err(error("not_found"));
            bump();
            #ok({ revision = mem.revision });
        };

        // Ignoring is a directory edit, not a trade decision: it changes who we
        // ask for catalogs and who we pass on, and nothing about chips already
        // held or offers already in flight.
        public func /*update*/chipswap_directory_set_ignored(
            request : IgnoreRequest
        ) : RevisionResult {
            let canister = switch (parsePrincipal(request.canister)) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            if (not Directory.setIgnored(mem, canister, request.ignored)) {
                return #err(error("not_found"));
            };
            bump();
            #ok({ revision = mem.revision });
        };

        // Retirement is a conclusion this canister drew from calls that went
        // unanswered, so the owner is allowed to overrule it in either
        // direction: to put a designer back into rotation whose canister was
        // merely stopped, or to retire one they know is gone without waiting for
        // three more failed calls to say so.
        public func /*update*/chipswap_directory_set_retired(
            request : RetireRequest
        ) : RevisionResult {
            let canister = switch (parsePrincipal(request.canister)) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            if (not Directory.setRetired(mem, canister, request.retired)) {
                return #err(error("not_found"));
            };
            bump();
            #ok({ revision = mem.revision });
        };

        // --- Brush library ----------------------------------------------------

        public func /*update*/chipswap_brush_save(
            request : SaveBrushRequest
        ) : RevisionResult {
            if (request.width == 0 or request.height == 0) return #err(error("brush_invalid"));
            if (request.width * request.height > MAX_BRUSH_CELLS) return #err(error("brush_invalid"));
            if (request.anchor_x >= request.width or request.anchor_y >= request.height) {
                return #err(error("brush_invalid"));
            };
            let name = Text.trim(request.name, #char ' ');
            if (name.size() == 0 or name.size() > MAX_BRUSH_NAME_CHARS) {
                return #err(error("brush_invalid"));
            };
            let ?cells = Trades.unhex(request.cells) else return #err(error("brush_invalid"));
            if (cells.size() != request.width * request.height) return #err(error("brush_invalid"));
            for (cell in cells.values()) {
                if (cell > 1) return #err(error("brush_invalid"));
            };

            switch (request.id) {
                case (?id) {
                    var replaced = false;
                    let updated = List.empty<Memory.CustomBrush>();
                    for (brush in List.values(mem.brushes)) {
                        if (brush.id == id) {
                            replaced := true;
                            List.add(
                                updated,
                                {
                                    id;
                                    name;
                                    width = request.width;
                                    height = request.height;
                                    anchor_x = request.anchor_x;
                                    anchor_y = request.anchor_y;
                                    cells;
                                } : Memory.CustomBrush,
                            );
                        } else List.add(updated, brush);
                    };
                    if (not replaced) return #err(error("not_found"));
                    List.clear(mem.brushes);
                    for (brush in List.values(updated)) List.add(mem.brushes, brush);
                };
                case null {
                    if (List.size(mem.brushes) >= MAX_BRUSHES) return #err(error("brush_limit"));
                    let id = mem.next_brush_id;
                    mem.next_brush_id += 1;
                    List.add(
                        mem.brushes,
                        {
                            id;
                            name;
                            width = request.width;
                            height = request.height;
                            anchor_x = request.anchor_x;
                            anchor_y = request.anchor_y;
                            cells;
                        } : Memory.CustomBrush,
                    );
                };
            };
            bump();
            #ok({ revision = mem.revision });
        };

        public func /*update*/chipswap_brush_delete(request : BrushRequest) : RevisionResult {
            var found = false;
            let kept = List.empty<Memory.CustomBrush>();
            for (brush in List.values(mem.brushes)) {
                if (brush.id == request.id) found := true else List.add(kept, brush);
            };
            if (not found) return #err(error("not_found"));
            List.clear(mem.brushes);
            for (brush in List.values(kept)) List.add(mem.brushes, brush);
            bump();
            #ok({ revision = mem.revision });
        };

        public func /*update*/chipswap_trade_forget(
            request : TradeRequestRef
        ) : RevisionResult {
            let ?requestId = Trades.unhex(request.request_id) else return #err(error("invalid_request"));
            switch (Trades.forgetOutgoing(mem, requestId)) {
                case (#err(code)) #err(error(code));
                case (#ok(())) {
                    bump();
                    #ok({ revision = mem.revision });
                };
            };
        };

        // --- Outbound protocol -----------------------------------------------

        // --- Crawl -------------------------------------------------------------

        // Begin again from the whole directory. Starting over rather than
        // resuming is the point of a separate call: a crawl that finished last
        // week has visited everyone, and asking it to continue would do nothing.
        public func /*update*/chipswap_crawl_start(()) : CrawlResult {
            Directory.startCrawl(mem, Time.now());
            bump();
            #ok(crawlView());
        };

        public func /*update*/chipswap_crawl_stop(()) : CrawlResult {
            Directory.stopCrawl(mem);
            bump();
            #ok(crawlView());
        };

        // One round of the crawl: ask up to eight peers for one page each of
        // their directory, save whoever is new, and report what is left.
        //
        // A peer who does not answer is dropped from this crawl rather than
        // retried, and is never struck for it. The route is a query, and a peer
        // on the previous release has no query dispatcher at all — retiring a
        // designer for not having upgraded yet would be a lie about the one
        // thing that flag claims to know.
        public func /*update*/chipswap_crawl_step(()) : async* CrawlResult {
            if (not Directory.crawling(mem)) return #err(error("no_crawl"));
            let targets = Directory.crawlTargets(mem, MAX_CRAWL_TARGETS);
            if (targets.size() == 0) {
                bump();
                return #ok(crawlView());
            };

            let payloads = Array.map<Directory.CrawlTarget, NeutronCapabilities.BackendCallRequestV1>(
                targets,
                func(target) {
                    routeCall(
                        target.canister,
                        INGRESS_QUERY_METHOD,
                        ROUTE_DIRECTORY,
                        to_candid ({ offset = target.offset; limit = CRAWL_PAGE } : PeerDirectoryRequest),
                        QUERY_ROUTE_CYCLES,
                    );
                },
            );
            let results = await* calls.call_batch(payloads);

            let now = Time.now();
            var index = 0;
            while (index < targets.size()) {
                let target = targets[index];
                let page = if (index < results.size()) {
                    directoryFromResult(?results[index]);
                } else null;
                switch (page) {
                    case (?answer) {
                        ignore Directory.noteCrawlPage(
                            mem,
                            target.canister,
                            target.offset,
                            answer.entries,
                            answer.total,
                            self,
                            now,
                        );
                    };
                    case null Directory.finishCrawlPeer(mem, target.canister);
                };
                index += 1;
            };
            bump();
            #ok(crawlView());
        };

        public func /*update*/chipswap_fetch_catalogs(
            request : FetchCatalogsRequest
        ) : async* FetchCatalogsResult {
            if (request.canisters.size() == 0) return #err(error("invalid_request"));
            if (request.canisters.size() > MAX_FETCH_TARGETS) return #err(error("too_many_targets"));
            let targets = List.empty<Principal>();
            for (text in request.canisters.values()) {
                switch (parsePrincipal(text)) {
                    case (#err(code)) return #err(error(code));
                    case (#ok(value)) {
                        // Ignored and retired designers drop out the same way we
                        // do: silently, because "did not answer" would be untrue
                        // of a call we chose not to make.
                        if (not Principal.equal(value, self) and Directory.reachable(mem, value)) {
                            List.add(targets, value);
                        };
                    };
                };
            };
            if (List.size(targets) == 0) return #err(error("invalid_request"));

            let now = Time.now();
            let payload = to_candid ({} : PeerCatalogRequest);
            let requests = Array.map<Principal, NeutronCapabilities.BackendCallRequestV1>(
                List.toArray(targets),
                func(target) {
                    routeCall(
                        target,
                        INGRESS_QUERY_METHOD,
                        ROUTE_CATALOG,
                        payload,
                        QUERY_ROUTE_CYCLES,
                    );
                },
            );
            let results = await* calls.call_batch(requests);

            let fetched = List.empty<Text>();
            let failed = List.empty<Text>();
            let ordered = List.toArray(targets);
            var index = 0;
            while (index < ordered.size()) {
                let target = ordered[index];
                let outcome = if (index < results.size()) ?results[index] else null;
                switch (catalogFromResult(outcome)) {
                    case (?catalog) {
                        Directory.storeCatalog(
                            mem,
                            target,
                            Array.map<Wire.Design, Memory.CachedDesign>(
                                catalog.designs,
                                func(design) {
                                    {
                                        design_id = design.design_id;
                                        title = design.title;
                                        art = design.art;
                                        requirements = requirementsFromWire(design.requirements);
                                        nsfw = design.nsfw;
                                        design_revision = design.design_revision;
                                        published_at_ns = design.published_at_ns;
                                    };
                                },
                            ),
                            now,
                        );
                        Directory.noteReachable(mem, target, now);
                        List.add(fetched, Principal.toText(target));
                    };
                    case null {
                        // Silence here concludes nothing about the designer.
                        // The catalog route is a query, and a peer on a release
                        // older than 108 exposes no query dispatcher to reject
                        // it with — retiring them for that would be retiring
                        // them for not having upgraded. Reachability is decided
                        // on the paid routes, where a rejection means what it
                        // says.
                        List.add(failed, Principal.toText(target));
                    };
                };
                index += 1;
            };
            bump();
            #ok({
                fetched = List.toArray(fetched);
                failed = List.toArray(failed);
                revision = mem.revision;
            });
        };

        public func /*update*/chipswap_trade_propose(
            request : ProposeTradeRequest
        ) : async* TradeActionResult {
            let peer = switch (parsePrincipal(request.peer)) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            let offer : Trades.OfferSelection = switch (request.offer_kind) {
                case ("own") {
                    let ?designId = request.offer_design_id else return #err(error("invalid_request"));
                    #own(designId);
                };
                case ("held") {
                    let ?chipKey = request.offer_chip_key else return #err(error("invalid_request"));
                    #held(chipKey);
                };
                case (_) return #err(error("invalid_request"));
            };

            let now = Time.now();
            let proposal = switch (
                Trades.beginPropose(
                    mem,
                    { peer; want_design_id = request.want_design_id; offer },
                    self,
                    now,
                )
            ) {
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            bump();

            let payload : PeerTradeRequest = {
                request_id = proposal.request_id;
                want_design_id = proposal.want_design_id;
                offered = proposal.offered;
            };
            let reply = await* callRoute(
                peer,
                ROUTE_TRADE,
                to_candid (payload),
                TRADE_CYCLES,
                16_384,
            );
            let answer = switch (reply) {
                case null null;
                case (?bytes) Wire.decodeTradeReply(bytes);
            };
            let outcome = switch (Trades.finishPropose(mem, proposal.request_id, answer, self, Time.now())) {
                case (#err(code)) {
                    bump();
                    return #err(error(code));
                };
                case (#ok(value)) value;
            };
            bump();
            #ok({
                request_id = Trades.hex(proposal.request_id);
                outcome;
                revision = mem.revision;
            });
        };

        public func /*update*/chipswap_trade_resolve(
            request : TradeRequestRef
        ) : async* TradeActionResult {
            let ?requestId = Trades.unhex(request.request_id) else return #err(error("invalid_request"));
            let ?trade = Trades.getOutgoing(mem, requestId) else return #err(error("unknown_trade"));
            let payload : PeerStatusRequest = { request_id = requestId };
            let reply = await* callRoute(
                trade.peer,
                ROUTE_STATUS,
                to_candid (payload),
                STATUS_CYCLES,
                16_384,
            );
            let answer = switch (reply) {
                case null null;
                case (?bytes) Wire.decodeStatusReply(bytes);
            };
            switch (Trades.resolveOutgoing(mem, requestId, answer, Time.now())) {
                case (#err(code)) {
                    bump();
                    #err(error(code));
                };
                case (#ok(outcome)) {
                    bump();
                    #ok({
                        request_id = request.request_id;
                        outcome;
                        revision = mem.revision;
                    });
                };
            };
        };

        public func /*update*/chipswap_trade_accept(
            request : TradeRequestRef
        ) : async* TradeActionResult {
            let ?requestId = Trades.unhex(request.request_id) else return #err(error("invalid_request"));
            let delivery = switch (Trades.acceptPending(mem, requestId, self, Time.now())) {
                case (#err("not_pending")) {
                    // Already accepted: this is a retry of a lost delivery.
                    switch (Trades.retryDelivery(mem, requestId, self)) {
                        case (#err(code)) return #err(error(code));
                        case (#ok(value)) value;
                    };
                };
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            bump();
            await* deliver(delivery, request.request_id);
        };

        public func /*update*/chipswap_trade_decline(
            request : TradeRequestRef
        ) : async* TradeActionResult {
            let ?requestId = Trades.unhex(request.request_id) else return #err(error("invalid_request"));
            let delivery = switch (Trades.declinePending(mem, requestId, Time.now())) {
                case (#err("not_pending")) {
                    switch (Trades.retryDelivery(mem, requestId, self)) {
                        case (#err(code)) return #err(error(code));
                        case (#ok(value)) value;
                    };
                };
                case (#err(code)) return #err(error(code));
                case (#ok(value)) value;
            };
            bump();
            await* deliver(delivery, request.request_id);
        };

        // --- Peer routes ------------------------------------------------------

        // Our published designs, for a peer's market. This is a query for the
        // same reason the crawl route is: reading a catalog no longer puts the
        // reader in our directory, and a route that records nothing about its
        // caller has no business charging them for the privilege. Browsing is
        // not a relationship; a designer who wants to be known to us can
        // propose a trade, which is.
        public func /*query*/chipswap_catalog_v1(
            _request : PeerCatalogRequest,
            /*caller*/ _caller : Principal,
        ) : Blob {
            let designs = Array.map<Memory.Design, Wire.Design>(
                Designs.published(mem),
                func(design) {
                    {
                        design_id = design.design_id;
                        title = design.title;
                        art = design.art;
                        requirements = requirementsToWire(design.requirements);
                        nsfw = design.nsfw;
                        design_revision = design.revision;
                        published_at_ns = switch (design.published_at_ns) {
                            case (?value) value;
                            case null design.created_at_ns;
                        };
                    };
                },
            );
            Wire.encodeCatalogReply({ designs });
        };

        public func /*update*/chipswap_trade_v1(
            request : PeerTradeRequest,
            /*caller*/ caller : Principal,
        ) : Blob {
            let reply = Trades.acceptInbound(
                mem,
                {
                    request_id = request.request_id;
                    want_design_id = request.want_design_id;
                    offered = request.offered;
                },
                caller,
                self,
                Time.now(),
            );
            bump();
            Wire.encodeTradeReply(reply);
        };

        public func /*update*/chipswap_deliver_v1(
            request : PeerDeliverRequest,
            /*caller*/ caller : Principal,
        ) : Blob {
            let now = Time.now();
            let outcome : Trades.DeliverOutcome = switch (request.outcome) {
                case (#minted(chip)) #minted(chip);
                case (#returned(chip)) #returned(chip);
                case (#declined) #declined;
            };
            let reply : Wire.DeliverReply = switch (
                Trades.deliverInbound(mem, request.request_id, caller, outcome, now)
            ) {
                case (#err(code)) #err({ code });
                case (#ok(_)) #ok;
            };
            bump();
            Wire.encodeDeliverReply(reply);
        };

        public func /*update*/chipswap_status_v1(
            request : PeerStatusRequest,
            /*caller*/ caller : Principal,
        ) : Blob {
            Wire.encodeStatusReply(Trades.statusOf(mem, request.request_id, caller, self));
        };

        // One page of our directory, for a peer's crawl. This is a query: it
        // reads, it cannot write, and so a crawl leaves no trace here and tells
        // us nothing about who is crawling. That is the trade this route makes —
        // it costs the caller no cycles and us no rate budget, and in exchange
        // neither side learns anything from the other's curiosity.
        public func /*query*/chipswap_directory_v1(
            request : PeerDirectoryRequest,
            /*caller*/ _caller : Principal,
        ) : Blob {
            let limit = if (request.limit == 0 or request.limit > Wire.MAX_DIRECTORY_PAGE) {
                Wire.MAX_DIRECTORY_PAGE;
            } else request.limit;
            let page = Directory.served(mem, self, request.offset, limit);
            Wire.encodeDirectoryReply({ entries = page.entries; total = page.total });
        };

        // --- Internals ---------------------------------------------------------

        func deliver(delivery : Trades.Delivery, requestIdText : Text) : async* TradeActionResult {
            let outcome : PeerDeliverOutcome = switch (delivery.outcome) {
                case (#minted(chip)) #minted(chip);
                case (#returned(chip)) #returned(chip);
                case (#declined) #declined;
            };
            let payload : PeerDeliverRequest = {
                request_id = delivery.request_id;
                outcome;
            };
            let reply = await* callRoute(
                delivery.peer,
                ROUTE_DELIVER,
                to_candid (payload),
                DELIVER_CYCLES,
                4_096,
            );
            let delivered = switch (reply) {
                case null false;
                case (?bytes) {
                    switch (Wire.decodeDeliverReply(bytes)) {
                        case (?#ok) true;
                        case (_) false;
                    };
                };
            };
            if (delivered) ignore Trades.completeDelivery(mem, delivery.request_id);
            bump();
            #ok({
                request_id = requestIdText;
                outcome = if (delivered) "delivered" else "delivery_pending";
                revision = mem.revision;
            });
        };

        // Every outbound call to a peer is built here and nowhere else. A peer
        // exposes one dispatcher per mode, not one method per route, so the
        // route name travels inside the argument: a request that forgets to
        // name its route does not reach a handler, it fails to decode at the
        // door. Building that envelope by hand at each call site is what let
        // one of them ship without it, so there is now only one hand to build
        // it with.
        func routeCall(
            target : Principal,
            physical : Text,
            route : Text,
            payload : Blob,
            cycles : Nat,
        ) : NeutronCapabilities.BackendCallRequestV1 {
            let envelope : NeutronCapabilities.PublicIngressRequestV1 = {
                method = route;
                payload;
            };
            {
                canister = target;
                method = physical;
                args = to_candid (envelope);
                cycles;
            };
        };

        // One paid call to a peer's update dispatcher. A failure of any kind
        // returns null: the caller decides what that means for its state.
        //
        // This is also where a designer's reachability is decided, because a
        // paid route is the only place it can honestly be decided. These three
        // routes have existed for as long as the protocol has, so a rejection
        // here is about the peer; the query routes cannot say the same, and do
        // not report through here.
        func callRoute(
            target : Principal,
            route : Text,
            payload : Blob,
            cycles : Nat,
            maxReplyBytes : Nat,
        ) : async* ?Blob {
            let result = await* calls.call(
                routeCall(target, INGRESS_METHOD, route, payload, cycles)
            );
            ignore Directory.noteCallResult(mem, target, result, Time.now());
            switch (result) {
                case (#err(_)) null;
                case (#ok(reply)) unwrapReply(reply, maxReplyBytes);
            };
        };

        func crawlView() : CrawlView {
            let progress = Directory.crawlProgress(mem);
            {
                active = progress.active;
                queried = progress.queried;
                discovered = progress.discovered;
                remaining = progress.remaining;
                full = progress.full;
            };
        };

        func directoryFromResult(
            result : ?NeutronCapabilities.BackendCallResultV1
        ) : ?Wire.DirectoryReply {
            let ?outcome = result else return null;
            let reply = switch (outcome) {
                case (#err(_)) return null;
                case (#ok(bytes)) bytes;
            };
            let ?payload = unwrapReply(reply, MAX_DIRECTORY_REPLY_BYTES) else return null;
            Wire.decodeDirectoryReply(payload);
        };

        func catalogFromResult(
            result : ?NeutronCapabilities.BackendCallResultV1
        ) : ?Wire.CatalogReply {
            let ?outcome = result else return null;
            let reply = switch (outcome) {
                case (#err(_)) return null;
                case (#ok(bytes)) bytes;
            };
            let ?payload = unwrapReply(reply, Wire.MAX_MESSAGE_BYTES) else return null;
            Wire.decodeCatalogReply(payload);
        };

        func unwrapReply(reply : Blob, maxPayloadBytes : Nat) : ?Blob {
            let ?inner = IngressWire.unwrapOk(reply, maxPayloadBytes + CANDID_SLACK) else return null;
            IngressWire.unwrapBlobReturn(inner, maxPayloadBytes);
        };

        func contactsAvailable() : Bool {
            switch (
                appCalls.contacts.contacts_neutron_search_v2({
                    search_text = "";
                    offset = 0;
                    limit = 1;
                })
            ) {
                case (#ok(_)) true;
                case (#err(_)) false;
            };
        };

        func contactName(canister : Principal) : ?Text {
            let result = appCalls.contacts.contacts_neutron_lookup_v2({
                principal = canister;
            });
            if (not result.integrity_ok) return null;
            switch (result.match) {
                case (?match) ?match.contact_name;
                case null null;
            };
        };

        func designTitle(designId : Nat) : Text {
            switch (Designs.get(mem, designId)) {
                case (?design) design.title;
                case null "";
            };
        };

        func designView(design : Memory.Design) : DesignView {
            {
                design_id = design.design_id;
                title = design.title;
                art = artView(design.art);
                state = switch (design.state) {
                    case (#draft) "draft";
                    case (#published) "published";
                };
                requirements = requirementsView(design.requirements);
                nsfw = design.nsfw;
                revision = design.revision;
                created_at_ns = design.created_at_ns;
                published_at_ns = design.published_at_ns;
                minted_count = design.next_serial - 1;
            };
        };

        // One of our own published designs, dressed as a chip. Serial 0 is the
        // tell: minted serials start at 1, so the key can never collide with a
        // holding, and there is no instance here to point at anyway. Nothing is
        // in flight, so there is no peer and no request to settle.
        func designChipView(design : Memory.Design) : ChipView {
            let published = switch (design.published_at_ns) {
                case (?value) value;
                case null design.created_at_ns;
            };
            {
                key = Holdings.key({
                    designer = self;
                    design_id = design.design_id;
                    serial = 0;
                });
                designer = Principal.toText(self);
                design_id = design.design_id;
                serial = 0;
                title = design.title;
                art = artView(design.art);
                nsfw = design.nsfw;
                design_revision = design.revision;
                minted_at_ns = published;
                acquired_at_ns = published;
                state = "held";
                peer = null;
                request_id = null;
                contact_name = null;
                origin = "design";
                minted_count = design.next_serial - 1;
            };
        };

        func chipView(chip : Memory.Chip) : ChipView {
            let (state, peer, requestId) = switch (chip.state) {
                case (#held) ("held", null : ?Text, null : ?Text);
                case (#escrowed(details)) (
                    "escrowed",
                    ?Principal.toText(details.peer),
                    ?Trades.hex(details.request_id),
                );
                case (#uncertain(details)) (
                    "uncertain",
                    ?Principal.toText(details.peer),
                    ?Trades.hex(details.request_id),
                );
            };
            {
                key = Holdings.key(chip.ref);
                designer = Principal.toText(chip.ref.designer);
                design_id = chip.ref.design_id;
                serial = chip.ref.serial;
                title = chip.title;
                art = artView(chip.art);
                nsfw = chip.nsfw;
                design_revision = chip.design_revision;
                minted_at_ns = chip.minted_at_ns;
                acquired_at_ns = chip.acquired_at_ns;
                state;
                peer;
                request_id = requestId;
                contact_name = contactName(chip.ref.designer);
                origin = "held";
                minted_count = 0;
            };
        };

        func bump() {
            mem.revision += 1;
        };
    };

    // --- Pure helpers ---------------------------------------------------------

    func activeOutgoing(state : Memory.OutgoingState) : Bool {
        switch (state) {
            case (#sending) true;
            case (#pending_designer) true;
            case (#uncertain) true;
            case (_) false;
        };
    };

    func incomingStateText(state : Memory.IncomingState) : Text {
        switch (state) {
            case (#pending) "pending";
            case (#accepted(_)) "accepted";
            case (#declined) "declined";
        };
    };

    func outgoingStateText(state : Memory.OutgoingState) : (Text, ?Text) {
        switch (state) {
            case (#sending) ("sending", null);
            case (#pending_designer) ("pending_designer", null);
            case (#completed(_)) ("completed", null);
            case (#declined(reason)) ("declined", ?reason);
            case (#failed(code)) ("failed", ?code);
            case (#uncertain) ("uncertain", null);
        };
    };

    func nsfwRuleText(rule : ?Memory.NsfwRule) : Text {
        switch (rule) {
            case (?#disallowed) "disallowed";
            case (?#required) "required";
            case null "any";
        };
    };

    func requirementsView(requirements : Memory.TradeRequirements) : RequirementsView {
        {
            approval = requirements.approval;
            min_colors = requirements.min_colors;
            max_coverage = requirements.max_coverage;
            nsfw = nsfwRuleText(requirements.nsfw);
        };
    };

    // The wire's requirement set is the schema's, spelled separately so the two
    // can move apart. Converting by hand is what keeps that promise honest.
    func requirementsToWire(requirements : Memory.TradeRequirements) : Wire.Requirements {
        {
            approval = requirements.approval;
            min_colors = requirements.min_colors;
            max_coverage = requirements.max_coverage;
            nsfw = switch (requirements.nsfw) {
                case (?#disallowed) ? #disallowed;
                case (?#required) ? #required;
                case null null;
            };
        };
    };

    func requirementsFromWire(requirements : Wire.Requirements) : Memory.TradeRequirements {
        {
            approval = requirements.approval;
            min_colors = requirements.min_colors;
            max_coverage = requirements.max_coverage;
            nsfw = switch (requirements.nsfw) {
                case (?#disallowed) ? #disallowed;
                case (?#required) ? #required;
                case null null;
            };
        };
    };

    func artView(art : Memory.Art) : ArtView {
        {
            shape_id = art.shape_id;
            palette = Array.map<Nat32, Text>(art.palette, colorText);
            pixels = Trades.hex(art.pixels);
        };
    };

    let HEX_DIGITS : [Text] = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f",
    ];

    func colorText(color : Nat32) : Text {
        var value = Nat32.toNat(color) % 16_777_216;
        var out = "";
        var index = 0;
        while (index < 6) {
            out := HEX_DIGITS[value % 16] # out;
            value /= 16;
            index += 1;
        };
        "#" # out;
    };

    func parseColor(value : Text) : ?Nat32 {
        let characters = Text.toArray(value);
        if (characters.size() != 7) return null;
        if (characters[0] != '#') return null;
        var total = 0;
        var index = 1;
        while (index < 7) {
            let ?digit = hexDigit(characters[index]) else return null;
            total := total * 16 + digit;
            index += 1;
        };
        ?Nat32.fromNat(total);
    };

    func hexDigit(character : Char) : ?Nat {
        switch (character) {
            case ('0') ?0;
            case ('1') ?1;
            case ('2') ?2;
            case ('3') ?3;
            case ('4') ?4;
            case ('5') ?5;
            case ('6') ?6;
            case ('7') ?7;
            case ('8') ?8;
            case ('9') ?9;
            case ('a') ?10;
            case ('b') ?11;
            case ('c') ?12;
            case ('d') ?13;
            case ('e') ?14;
            case ('f') ?15;
            case (_) null;
        };
    };

    func parsePalette(palette : [Text]) : { #ok : [Nat32]; #err : Text } {
        if (palette.size() == 0) return #err("palette_empty");
        if (palette.size() > Shape.MAX_PALETTE) return #err("palette_limit");
        let colors = List.empty<Nat32>();
        for (entry in palette.values()) {
            let ?color = parseColor(entry) else return #err("palette_invalid");
            List.add(colors, color);
        };
        #ok(List.toArray(colors));
    };

    func parsePixels(pixels : Text) : { #ok : Blob; #err : Text } {
        let ?bytes = Trades.unhex(pixels) else return #err("pixels_invalid");
        if (bytes.size() != Shape.PIXEL_COUNT) return #err("pixel_count");
        #ok(bytes);
    };

    // The ranges live in Requirements.mo, so a requirement the owner sets and a
    // requirement that arrives from a peer are held to the same bounds.
    func parseRequirements(
        approval : Bool,
        minColors : ?Nat,
        maxCoverage : ?Nat,
        nsfwRule : Text,
    ) : { #ok : Memory.TradeRequirements; #err : Text } {
        let nsfw : ?Memory.NsfwRule = switch (nsfwRule) {
            case ("any") null;
            case ("disallowed") ? #disallowed;
            case ("required") ? #required;
            case (_) return #err("nsfw_rule_invalid");
        };
        let requirements : Memory.TradeRequirements = {
            approval;
            min_colors = minColors;
            max_coverage = maxCoverage;
            nsfw;
        };
        if (not Requirements.valid(requirements)) return #err("requirements_invalid");
        #ok(requirements);
    };

    // Principal.fromText traps on malformed input, so owner-supplied text goes
    // through the non-trapping parser and must be a canister id.
    func parsePrincipal(value : Text) : { #ok : Principal; #err : Text } {
        let ?candidate = PrincipalText.parse(value) else return #err("principal_invalid");
        if (not Principal.isCanister(candidate)) return #err("principal_not_canister");
        #ok(candidate);
    };

    func boundedLimit(limit : Nat) : Nat {
        if (limit == 0) return 20;
        if (limit > 100) return 100;
        limit;
    };

    func error(code : Text) : Err {
        { code; message = messageFor(code) };
    };

    func messageFor(code : Text) : Text {
        switch (code) {
            case ("slot_limit") "All ten design slots are in use.";
            case ("not_found") "That record no longer exists.";
            case ("immutable") "A published design cannot be changed.";
            case ("revision_conflict") "This design changed since it was loaded.";
            case ("title_invalid") "Titles are 1 to 48 characters.";
            case ("palette_empty") "A chip needs at least one color.";
            case ("palette_limit") "A palette holds at most 64 colors.";
            case ("palette_invalid") "Colors must look like #rrggbb.";
            case ("palette_index") "A pixel refers to a color that is not in the palette.";
            case ("pixel_count") "A chip has exactly 757 pixels.";
            case ("pixels_invalid") "Pixel data must be lowercase hexadecimal.";
            case ("shape_unsupported") "That chip shape is not supported.";
            case ("not_published") "Only a published design can be minted.";
            case ("self_trade") "A Neutron cannot trade with itself.";
            case ("self_entry") "That is this Neutron's own address.";
            case ("unknown_design") "That design is not in the designer's catalog.";
            case ("unknown_trade") "That trade is not known here.";
            case ("holdings_full") "This collection is full.";
            case ("outgoing_full") "Too many trades are already in flight.";
            case ("incoming_full") "Too many offers are already waiting.";
            case ("duplicate") "That chip is already in this collection.";
            case ("not_available") "That chip is committed to another trade.";
            case ("not_pending") "That offer is no longer waiting for a decision.";
            case ("not_delivered") "That offer has not been decided yet.";
            case ("not_final") "That trade is still in progress.";
            case ("not_resolvable") "That trade has already finished.";
            case ("unreachable") "The other Neutron did not answer.";
            case ("invalid_reply") "The other Neutron sent an answer this app cannot trust.";
            case ("invalid_status") "The status answer did not match this trade.";
            case ("invalid_delivery") "The delivered chip did not match this trade.";
            case ("invalid_request") "That request was not valid.";
            case ("invalid_peer") "That address is not a canister.";
            case ("principal_invalid") "That is not a valid principal.";
            case ("principal_not_canister") "A Chipswap address is a canister principal.";
            case ("too_many_targets") "Refresh at most eight designers at a time.";
            case ("requirements_invalid") "A color minimum is 2 to 64, and a coverage cap is 1 to 99 percent.";
            case ("nsfw_rule_invalid") "The NSFW rule is any, disallowed, or required.";
            case ("min_colors") "That chip does not use enough colors for this design.";
            case ("max_coverage") "One color covers too much of that chip for this design.";
            case ("nsfw_disallowed") "This design does not accept chips tagged NSFW.";
            case ("nsfw_required") "This design only accepts chips tagged NSFW.";
            case ("brush_invalid") "That brush shape is not valid.";
            case ("brush_limit") "The brush library is full.";
            case ("not_received") "The designer never received this offer.";
            case ("request_reused") "That request id was already used.";
            case (_) "The action could not be completed.";
        };
    };

    /*---NEUTRON GENERATED BEGIN---*/

public type chipswap_status_Input = (());
public type chipswap_status_Output = StatusView;

public type chipswap_designs_Input = (());
public type chipswap_designs_Output = [DesignView];

public type chipswap_design_Input = (request : DesignRequest);
public type chipswap_design_Output = ?DesignView;

public type chipswap_collection_Input = (request : PageRequest);
public type chipswap_collection_Output = CollectionPage;

public type chipswap_directory_Input = (request : PageRequest);
public type chipswap_directory_Output = DirectoryPage;

public type chipswap_store_Input = (request : StoreRequest);
public type chipswap_store_Output = StorePage;

public type chipswap_trades_Input = (());
public type chipswap_trades_Output = TradesView;

public type chipswap_brushes_Input = (());
public type chipswap_brushes_Output = [BrushView];

public type chipswap_contacts_suggestions_Input = (request : SuggestionRequest);
public type chipswap_contacts_suggestions_Output = SuggestionPage;

public type chipswap_draft_create_Input = (request : CreateDraftRequest);
public type chipswap_draft_create_Output = CreateDesignResult;

public type chipswap_draft_save_Input = (request : SaveDraftRequest);
public type chipswap_draft_save_Output = RevisionResult;

public type chipswap_draft_delete_Input = (request : DesignRequest);
public type chipswap_draft_delete_Output = RevisionResult;

public type chipswap_publish_Input = (request : PublishRequest);
public type chipswap_publish_Output = RevisionResult;

public type chipswap_set_trade_policy_Input = (request : TradePolicyRequest);
public type chipswap_set_trade_policy_Output = RevisionResult;

public type chipswap_directory_add_Input = (request : DirectoryAddRequest);
public type chipswap_directory_add_Output = RevisionResult;

public type chipswap_directory_remove_Input = (request : CanisterRequest);
public type chipswap_directory_remove_Output = RevisionResult;

public type chipswap_directory_set_ignored_Input = (request : IgnoreRequest);
public type chipswap_directory_set_ignored_Output = RevisionResult;

public type chipswap_directory_set_retired_Input = (request : RetireRequest);
public type chipswap_directory_set_retired_Output = RevisionResult;

public type chipswap_brush_save_Input = (request : SaveBrushRequest);
public type chipswap_brush_save_Output = RevisionResult;

public type chipswap_brush_delete_Input = (request : BrushRequest);
public type chipswap_brush_delete_Output = RevisionResult;

public type chipswap_trade_forget_Input = (request : TradeRequestRef);
public type chipswap_trade_forget_Output = RevisionResult;

public type chipswap_crawl_start_Input = (());
public type chipswap_crawl_start_Output = CrawlResult;

public type chipswap_crawl_stop_Input = (());
public type chipswap_crawl_stop_Output = CrawlResult;

public type chipswap_crawl_step_Input = (());
public type chipswap_crawl_step_Output = CrawlResult;

public type chipswap_fetch_catalogs_Input = (request : FetchCatalogsRequest);
public type chipswap_fetch_catalogs_Output = FetchCatalogsResult;

public type chipswap_trade_propose_Input = (request : ProposeTradeRequest);
public type chipswap_trade_propose_Output = TradeActionResult;

public type chipswap_trade_resolve_Input = (request : TradeRequestRef);
public type chipswap_trade_resolve_Output = TradeActionResult;

public type chipswap_trade_accept_Input = (request : TradeRequestRef);
public type chipswap_trade_accept_Output = TradeActionResult;

public type chipswap_trade_decline_Input = (request : TradeRequestRef);
public type chipswap_trade_decline_Output = TradeActionResult;

public type chipswap_catalog_v1_Input = (_request : PeerCatalogRequest);
public type chipswap_catalog_v1_Output = Blob;

public type chipswap_trade_v1_Input = (request : PeerTradeRequest);
public type chipswap_trade_v1_Output = Blob;

public type chipswap_deliver_v1_Input = (request : PeerDeliverRequest);
public type chipswap_deliver_v1_Output = Blob;

public type chipswap_status_v1_Input = (request : PeerStatusRequest);
public type chipswap_status_v1_Output = Blob;

public type chipswap_directory_v1_Input = (request : PeerDirectoryRequest);
public type chipswap_directory_v1_Output = Blob;

/*---NEUTRON GENERATED END---*/
}
