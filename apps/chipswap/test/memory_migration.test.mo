import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Migrate "../backend/memory/chipswap/v1_to_v2";
import V1 "../backend/memory/chipswap/v1";

// Migration from the released schema, with something in every root. Compiling
// proves the shapes line up; only this proves the values arrive intact and that
// the trade mode became the requirement it stood for.

let designer = Principal.fromBlob(Blob.fromArray([0, 1, 1]));
let peer = Principal.fromBlob(Blob.fromArray([0, 2, 1]));
let requestId = Blob.fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

let art : V1.Art = {
    shape_id = "circle31";
    palette = [0x000000, 0xffffff];
    pixels = Blob.fromArray([0, 1, 0]);
};

func design(id : Nat, mode : V1.TradeMode, state : V1.DesignState) : V1.Design {
    {
        design_id = id;
        title = "Design " # Nat.toText(id);
        art;
        state;
        trade_mode = mode;
        revision = id + 1;
        created_at_ns = 100 + id;
        published_at_ns = if (state == #published) ?(200 + id) else null;
        next_serial = id + 3;
    };
};

let chip : V1.Chip = {
    ref = { designer; design_id = 1; serial = 7 };
    title = "Held";
    art;
    design_revision = 2;
    minted_at_ns = 20;
    acquired_at_ns = 21;
    state = #held;
};

let old = V1.init();
old.revision := 12;
old.next_request_seq := 5;
old.next_brush_id := 3;
old.settings := { auto_announce = true };
Map.add(old.designs, Nat.compare, 1, design(1, #auto, #published));
Map.add(old.designs, Nat.compare, 2, design(2, #manual, #published));
Map.add(old.designs, Nat.compare, 3, design(3, #manual, #draft));
// The ordinary case on an upgrade: a draft created and never re-policied, which
// in V1 meant the mode `create` gave it.
Map.add(old.designs, Nat.compare, 4, design(4, #auto, #draft));
Map.add(old.holdings, Text.compare, "held", chip);
Map.add(
    old.holdings,
    Text.compare,
    "sent",
    { chip with state = #escrowed({ request_id = requestId; peer; since_ns = 30 }) },
);
Map.add(
    old.directory,
    Principal.compare,
    peer,
    {
        canister = peer;
        source = #contacts;
        first_seen_ns = 5;
        last_seen_ns = 6;
        announced = true;
        last_catalog_ns = ?7;
        design_count = 2;
    } : V1.DirectoryEntry,
);
Map.add(
    old.catalog_cache,
    Principal.compare,
    peer,
    {
        designer = peer;
        fetched_at_ns = 30;
        designs = [
            {
                design_id = 4;
                title = "Peer auto";
                art;
                trade_mode = #auto;
                design_revision = 4;
                published_at_ns = 12;
            },
            {
                design_id = 5;
                title = "Peer manual";
                art;
                trade_mode = #manual;
                design_revision = 5;
                published_at_ns = 13;
            },
        ];
    } : V1.CachedCatalog,
);
Map.add(
    old.incoming,
    Text.compare,
    "inbound",
    {
        request_id = requestId;
        peer;
        want_design_id = 1;
        offered = chip;
        state = #pending;
        received_at_ns = 40;
        updated_at_ns = 41;
    } : V1.IncomingTrade,
);
Map.add(
    old.outgoing,
    Text.compare,
    "outbound",
    {
        request_id = requestId;
        peer;
        want_design_id = 5;
        offered_key = ?"sent";
        offered_ref = { designer; design_id = 1; serial = 7 };
        offered_title = "Held";
        state = #pending_designer;
        created_at_ns = 50;
        updated_at_ns = 51;
    } : V1.OutgoingTrade,
);
Map.add(
    old.replay,
    Text.compare,
    "replay",
    {
        request_id = requestId;
        peer;
        outcome = #minted({ design_id = 1; serial = 9 });
        recorded_at_ns = 60;
    } : V1.ReplayRecord,
);
List.add(
    old.brushes,
    {
        id = 1;
        name = "L";
        width = 3;
        height = 3;
        anchor_x = 0;
        anchor_y = 0;
        cells = Blob.fromArray([1, 0, 0, 1, 0, 0, 1, 1, 0]);
    } : V1.CustomBrush,
);

let fresh = Migrate.migrate(old);

// Scalars and settings come across unchanged.
assert (fresh.revision == 12);
assert (fresh.next_request_seq == 5);
assert (fresh.next_brush_id == 3);
assert (fresh.settings.auto_announce);

// Every root keeps its population.
assert (Map.size(fresh.designs) == 4);
assert (Map.size(fresh.holdings) == 2);
assert (Map.size(fresh.directory) == 1);
assert (Map.size(fresh.catalog_cache) == 1);
assert (Map.size(fresh.incoming) == 1);
assert (Map.size(fresh.outgoing) == 1);
assert (Map.size(fresh.replay) == 1);
assert (List.size(fresh.brushes) == 1);

// `#auto` accepted anything, so it becomes a design that asks for nothing.
let ?auto = Map.get(fresh.designs, Nat.compare, 1) else Runtime.trap("missing design");
assert (not auto.requirements.approval);
assert (auto.requirements.min_colors == null);
assert (auto.requirements.max_coverage == null);
assert (auto.requirements.nsfw == null);
assert (auto.state == #published);
assert (auto.published_at_ns == ?201);
assert (auto.title == "Design 1");
assert (auto.revision == 2);
assert (auto.next_serial == 4);
assert (auto.art.palette == [0x000000, 0xffffff]);

// `#manual` asked the designer to approve, and asked nothing of the artwork.
let ?manual = Map.get(fresh.designs, Nat.compare, 2) else Runtime.trap("missing design");
assert (manual.requirements.approval);
assert (manual.requirements.min_colors == null);
assert (manual.requirements.max_coverage == null);
assert (manual.requirements.nsfw == null);

// A draft migrates as a draft, whole. This is the case that matters most on an
// upgrade: unpublished work exists nowhere but here, so its title, its artwork,
// its slot and its revision all have to arrive unchanged, and it must not come
// out looking published.
let ?draft = Map.get(fresh.designs, Nat.compare, 3) else Runtime.trap("missing design");
assert (draft.state == #draft);
assert (draft.published_at_ns == null);
assert (draft.design_id == 3);
assert (draft.title == "Design 3");
assert (draft.revision == 4);
assert (draft.next_serial == 6);
assert (draft.created_at_ns == 103);
assert (draft.art.shape_id == "circle31");
assert (draft.art.palette == [0x000000, 0xffffff]);
assert (draft.art.pixels == Blob.fromArray([0, 1, 0]));
// The mode converts the same way whatever the state, so a draft that had been
// set to "designer approves" keeps that as its one requirement.
assert (draft.requirements.approval);
assert (draft.requirements.min_colors == null);
assert (draft.requirements.max_coverage == null);
assert (draft.requirements.nsfw == null);

// And a draft still carrying what `create` gave it arrives asking nothing at
// all, which is what a draft created under V1 and never published looks like.
let ?plainDraft = Map.get(fresh.designs, Nat.compare, 4) else Runtime.trap("missing design");
assert (plainDraft.state == #draft);
assert (plainDraft.title == "Design 4");
assert (plainDraft.art.pixels == Blob.fromArray([0, 1, 0]));
assert (not plainDraft.requirements.approval);
assert (plainDraft.requirements.min_colors == null);
assert (plainDraft.requirements.max_coverage == null);
assert (plainDraft.requirements.nsfw == null);
assert (not plainDraft.nsfw);

// Nothing in V1 recorded a tag, so nothing arrives tagged.
assert (not auto.nsfw and not manual.nsfw and not draft.nsfw);

// A chip already in a collection keeps its identity and its commitment.
let ?held = Map.get(fresh.holdings, Text.compare, "held") else Runtime.trap("missing chip");
assert (held.ref.serial == 7);
assert (held.title == "Held");
assert (held.state == #held);
assert (not held.nsfw);
let ?sent = Map.get(fresh.holdings, Text.compare, "sent") else Runtime.trap("missing chip");
switch (sent.state) {
    case (#escrowed(details)) {
        assert (details.since_ns == 30);
        assert (Principal.equal(details.peer, peer));
        assert (details.request_id == requestId);
    };
    case (_) Runtime.trap("escrow was not preserved");
};

// Cached catalogs convert the same way designs do, so the store reads the same
// policy it read before the upgrade.
let ?catalog = Map.get(fresh.catalog_cache, Principal.compare, peer) else Runtime.trap("missing catalog");
assert (catalog.fetched_at_ns == 30);
assert (catalog.designs.size() == 2);
assert (not catalog.designs[0].requirements.approval);
assert (catalog.designs[1].requirements.approval);
assert (not catalog.designs[0].nsfw and not catalog.designs[1].nsfw);
assert (catalog.designs[1].title == "Peer manual");

// A directory entry keeps whether we announced ourselves to it: re-announcing
// is a decision the owner made once.
let ?entry = Map.get(fresh.directory, Principal.compare, peer) else Runtime.trap("missing entry");
assert (entry.announced);
assert (entry.source == #contacts);
assert (entry.last_catalog_ns == ?7);
assert (entry.design_count == 2);

// Trades in flight survive, so an upgrade mid-trade does not lose a chip.
let ?inbound = Map.get(fresh.incoming, Text.compare, "inbound") else Runtime.trap("missing trade");
assert (inbound.state == #pending);
assert (inbound.offered.ref.serial == 7);
assert (not inbound.offered.nsfw);
let ?outbound = Map.get(fresh.outgoing, Text.compare, "outbound") else Runtime.trap("missing trade");
assert (outbound.state == #pending_designer);
assert (outbound.offered_key == ?"sent");
assert (outbound.offered_title == "Held");

// The replay record is what makes a repeated request idempotent, so it has to
// arrive intact or a peer's retry could mint twice.
let ?replay = Map.get(fresh.replay, Text.compare, "replay") else Runtime.trap("missing replay");
// A version 1 chip left untagged, so the replayed delivery hands over an
// untagged chip rather than one wearing whatever the design says today.
assert (replay.outcome == #minted({ design_id = 1; serial = 9; nsfw = false }));
assert (replay.recorded_at_ns == 60);

let ?brush = List.get(fresh.brushes, 0) else Runtime.trap("missing brush");
assert (brush.name == "L");
assert (brush.cells == Blob.fromArray([1, 0, 0, 1, 0, 0, 1, 1, 0]));
