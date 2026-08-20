import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Migrate "../backend/memory/chipswap/v1_to_v2";
import Migrate3 "../backend/memory/chipswap/v2_to_v3";
import Migrate4 "../backend/memory/chipswap/v3_to_v4";
import Migrate5 "../backend/memory/chipswap/v4_to_v5";
import V1 "../backend/memory/chipswap/v1";
import V3 "../backend/memory/chipswap/v3";
import V4 "../backend/memory/chipswap/v4";
import V5 "../backend/memory/chipswap/v5";

// Migration from the released schemas, with something in every root. Compiling
// proves the shapes line up; only this proves the values arrive intact and that
// the trade mode became the requirement it stood for.
//
// The file walks all three legs in order, because that is the upgrade a
// canister still running version 1 actually performs: the kernel composes
// 1 -> 2 -> 3 -> 4 into one atomic upgrade, so each leg is fed exactly what the
// one before it produced rather than a hand-built fixture.

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

// --- Second leg: V2 -> V3 ---------------------------------------------------

let migrated = Migrate3.migrate(fresh);

// Nothing is dropped on the way through. The V2 settings root is the one thing
// that does not arrive, because V3 has no settings: announcing is a per-peer
// decision again, and `announced` records those individually.
assert (migrated.revision == 12);
assert (migrated.next_request_seq == 5);
assert (migrated.next_brush_id == 3);
assert (Map.size(migrated.designs) == 4);
assert (Map.size(migrated.holdings) == 2);
assert (Map.size(migrated.directory) == 1);
assert (Map.size(migrated.catalog_cache) == 1);
assert (Map.size(migrated.incoming) == 1);
assert (Map.size(migrated.outgoing) == 1);
assert (Map.size(migrated.replay) == 1);
assert (List.size(migrated.brushes) == 1);

// The drafts are still the thing most worth checking: they exist nowhere but
// here, and they have now survived two conversions rather than one.
let ?draft3 = Map.get(migrated.designs, Nat.compare, 3) else Runtime.trap("missing design");
assert (draft3.state == #draft);
assert (draft3.published_at_ns == null);
assert (draft3.title == "Design 3");
assert (draft3.revision == 4);
assert (draft3.next_serial == 6);
assert (draft3.created_at_ns == 103);
assert (draft3.art.palette == [0x000000, 0xffffff]);
assert (draft3.art.pixels == Blob.fromArray([0, 1, 0]));
assert (draft3.requirements.approval);
assert (not draft3.nsfw);

let ?plainDraft3 = Map.get(migrated.designs, Nat.compare, 4) else Runtime.trap("missing design");
assert (plainDraft3.state == #draft);
assert (plainDraft3.title == "Design 4");
assert (not plainDraft3.requirements.approval);

// Published policy is untouched by this leg.
let ?published3 = Map.get(migrated.designs, Nat.compare, 2) else Runtime.trap("missing design");
assert (published3.state == #published);
assert (published3.requirements.approval);
assert (published3.published_at_ns == ?202);

// Nobody could have been ignored before this version, so nobody arrives
// ignored — and the announcement already made is still recorded.
let ?entry3 = Map.get(migrated.directory, Principal.compare, peer) else Runtime.trap("missing entry");
assert (not entry3.ignored);
assert (entry3.announced);
assert (entry3.source == #contacts);
assert (entry3.first_seen_ns == 5);
assert (entry3.last_seen_ns == 6);
assert (entry3.last_catalog_ns == ?7);
assert (entry3.design_count == 2);

// Chips, trades in flight and the replay record cross the second leg intact,
// so an upgrade mid-trade still cannot lose a chip or mint one twice.
let ?held3 = Map.get(migrated.holdings, Text.compare, "held") else Runtime.trap("missing chip");
assert (held3.ref.serial == 7);
assert (held3.title == "Held");
assert (held3.state == #held);
let ?sent3 = Map.get(migrated.holdings, Text.compare, "sent") else Runtime.trap("missing chip");
switch (sent3.state) {
    case (#escrowed(details)) assert (details.request_id == requestId);
    case (_) Runtime.trap("escrow was not preserved");
};
let ?inbound3 = Map.get(migrated.incoming, Text.compare, "inbound") else Runtime.trap("missing trade");
assert (inbound3.state == #pending);
assert (inbound3.offered.ref.serial == 7);
let ?replay3 = Map.get(migrated.replay, Text.compare, "replay") else Runtime.trap("missing replay");
assert (replay3.outcome == #minted({ design_id = 1; serial = 9; nsfw = false }));

let ?catalog3 = Map.get(migrated.catalog_cache, Principal.compare, peer) else Runtime.trap("missing catalog");
assert (catalog3.designs.size() == 2);
assert (catalog3.designs[1].title == "Peer manual");
assert (catalog3.designs[1].requirements.approval);

let ?brush3 = List.get(migrated.brushes, 0) else Runtime.trap("missing brush");
assert (brush3.name == "L");
assert (brush3.cells == Blob.fromArray([1, 0, 0, 1, 0, 0, 1, 1, 0]));


// --- Third leg: 3 -> 4 -------------------------------------------------------

// Two source variants disappear in V4, so the fixture needs one entry of each
// before the leg runs. They are added to the V3 memory the second leg produced,
// which is where a real canister would have them.
let announcedPeer = Principal.fromBlob(Blob.fromArray([0, 3, 1]));
let exchangedPeer = Principal.fromBlob(Blob.fromArray([0, 4, 1]));
func v3Entry(canister : Principal, source : V3.DirectorySource) : V3.DirectoryEntry {
    {
        canister;
        source;
        first_seen_ns = 11;
        last_seen_ns = 12;
        announced = true;
        ignored = false;
        last_catalog_ns = null;
        design_count = 0;
    };
};
Map.add(migrated.directory, Principal.compare, announcedPeer, v3Entry(announcedPeer, #announce));
Map.add(migrated.directory, Principal.compare, exchangedPeer, v3Entry(exchangedPeer, #exchange));
// An ignored designer proves the flag crosses rather than being reset, which is
// the one directory field a V3 owner could actually have set on purpose.
let ?beforeIgnore = Map.get(migrated.directory, Principal.compare, peer) else Runtime.trap("missing entry");
Map.add(migrated.directory, Principal.compare, peer, { beforeIgnore with ignored = true });

let current = Migrate4.migrate(migrated);

// Every root crosses the third leg with the same contents.
assert (current.revision == 12);
assert (current.next_request_seq == 5);
assert (current.next_brush_id == 3);
assert (Map.size(current.designs) == 4);
assert (Map.size(current.holdings) == 2);
assert (Map.size(current.directory) == 3);
assert (Map.size(current.catalog_cache) == 1);
assert (Map.size(current.incoming) == 1);
assert (Map.size(current.outgoing) == 1);
assert (Map.size(current.replay) == 1);
assert (List.size(current.brushes) == 1);

// No crawl is in progress on an upgrade. There is nowhere for one to have been.
switch (current.crawl) {
    case null {};
    case (?_) Runtime.trap("a crawl arrived from nowhere");
};

// The two departing sources get the successor that keeps the answer to the
// question the field is read for: did the owner choose this designer? Neither
// did, and neither does now.
let ?announcedNow = Map.get(current.directory, Principal.compare, announcedPeer) else Runtime.trap("missing entry");
assert (announcedNow.source == #trade);
let ?exchangedNow = Map.get(current.directory, Principal.compare, exchangedPeer) else Runtime.trap("missing entry");
assert (exchangedNow.source == #crawl);

// A source the owner did choose is untouched, and so is the flag they set.
let ?entry4 = Map.get(current.directory, Principal.compare, peer) else Runtime.trap("missing entry");
assert (entry4.source == #contacts);
assert (entry4.ignored);
assert (entry4.first_seen_ns == 5);
assert (entry4.last_seen_ns == 6);
assert (entry4.last_catalog_ns == ?7);
assert (entry4.design_count == 2);

// Nobody has been retired or has struck out before this version, so everyone
// arrives with a clean record and a full three chances.
for ((_, entry) in Map.entries(current.directory)) {
    assert (not entry.retired);
    assert (entry.strikes == 0);
};

// The drafts have now survived three conversions, and the trade in flight still
// holds the chip it escrowed.
let ?draft4 = Map.get(current.designs, Nat.compare, 3) else Runtime.trap("missing design");
assert (draft4.state == #draft);
assert (draft4.title == "Design 3");
assert (draft4.requirements.approval);
assert (draft4.art.pixels == Blob.fromArray([0, 1, 0]));
let ?sent4 = Map.get(current.holdings, Text.compare, "sent") else Runtime.trap("missing chip");
switch (sent4.state) {
    case (#escrowed(details)) assert (details.request_id == requestId);
    case (_) Runtime.trap("escrow was not preserved");
};
let ?replay4 = Map.get(current.replay, Text.compare, "replay") else Runtime.trap("missing replay");
assert (replay4.outcome == #minted({ design_id = 1; serial = 9; nsfw = false }));
let ?brush4 = List.get(current.brushes, 0) else Runtime.trap("missing brush");
assert (brush4.cells == Blob.fromArray([1, 0, 0, 1, 0, 0, 1, 1, 0]));


// --- The fourth leg: V4 -> V5 ------------------------------------------------

// V5's only change is what a clean install starts with, so the migration's job
// is to do nothing at all to an installed directory. That is worth asserting
// rather than assuming, because the tempting version of this migration — seed
// everyone, they will thank us — hands an address to owners who never asked for
// one and re-adds a designer somebody removed on purpose.
let latest = Migrate5.migrate(current);

// The seed is not among them. Nobody upgrading gains an entry.
assert (Map.size(latest.directory) == Map.size(current.directory));
switch (Map.get(latest.directory, Principal.compare, V5.seedDesigner())) {
    case null {};
    case (?_) Runtime.trap("an upgrade planted the seed designer");
};
for ((_, entry) in Map.entries(latest.directory)) {
    assert (entry.source != #seed);
};

// The entries that were there arrive as themselves, decision fields included.
let ?carried = Map.get(latest.directory, Principal.compare, peer) else Runtime.trap("missing entry");
assert (carried.source == #contacts);
assert (carried.ignored);
assert (carried.first_seen_ns == 5);
assert (carried.last_seen_ns == 6);
assert (carried.last_catalog_ns == ?7);
assert (carried.design_count == 2);
let ?crawled = Map.get(latest.directory, Principal.compare, exchangedPeer) else Runtime.trap("missing entry");
assert (crawled.source == #crawl);

// And so does everything the directory is not: designs, the escrowed chip, the
// replay record and the brush have now survived four conversions.
assert (latest.revision == current.revision);
assert (latest.next_request_seq == current.next_request_seq);
assert (latest.next_brush_id == current.next_brush_id);
let ?draft5 = Map.get(latest.designs, Nat.compare, 3) else Runtime.trap("missing design");
assert (draft5.state == #draft);
assert (draft5.title == "Design 3");
assert (draft5.requirements.approval);
assert (draft5.art.pixels == Blob.fromArray([0, 1, 0]));
let ?sent5 = Map.get(latest.holdings, Text.compare, "sent") else Runtime.trap("missing chip");
switch (sent5.state) {
    case (#escrowed(details)) assert (details.request_id == requestId);
    case (_) Runtime.trap("escrow was not preserved");
};
assert (Map.size(latest.incoming) == Map.size(current.incoming));
assert (Map.size(latest.outgoing) == Map.size(current.outgoing));
let ?replay5 = Map.get(latest.replay, Text.compare, "replay") else Runtime.trap("missing replay");
assert (replay5.outcome == #minted({ design_id = 1; serial = 9; nsfw = false }));
let ?brush5 = List.get(latest.brushes, 0) else Runtime.trap("missing brush");
assert (brush5.cells == Blob.fromArray([1, 0, 0, 1, 0, 0, 1, 1, 0]));

// An installed canister whose owner emptied their directory keeps it empty. The
// seed is what an install begins with, not a correction an upgrade applies.
let emptied = Migrate5.migrate(V4.init());
assert (Map.size(emptied.directory) == 0);

// A crawl does not survive an upgrade, the same way it did not survive the last
// one: the peers it was midway through asking are a live call graph, not state.
switch (emptied.crawl) {
    case null {};
    case (?_) Runtime.trap("a migration started a crawl");
};
