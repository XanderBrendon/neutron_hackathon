import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import NeutronCapabilities "mo:neutron-capabilities";
import Chipswap "../backend/main";
import Trades "../backend/Trades";
import Memory "../backend/memory/chipswap/v9";
import Shape "../backend/Shape";
import Wire "../backend/Wire";

let self = Principal.fromBlob(Blob.fromArray([0, 0, 0, 0, 0, 16, 0, 1, 1, 1]));
let peer = Principal.fromBlob(Blob.fromArray([0, 0, 0, 0, 0, 16, 0, 2, 1, 1]));

// The walk below is about designs, trades and directory edits, so it starts
// from a directory it controls entirely. What a clean install actually begins
// with is asserted on its own at the end of this file.
let memory = Memory.init();
Map.remove(memory.directory, Principal.compare, Memory.seedDesigner());
assert (memory.revision == 0);

// Contacts is a declared install-time dependency; the stub stands in for the
// installed address book.
func environmentFor(mem : Memory.Mem, who : Principal) : Chipswap.AppBackendEnvironment = {
    stable_memory = { chipswap = mem };
    app_calls = {
        contacts = {
            contacts_neutron_lookup_v2 = func(_request : { principal : Principal }) : Chipswap.NeutronContactLookupV2 {
                { book_revision = 1; integrity_ok = true; match = null };
            };
            contacts_neutron_search_v2 = func(
                _request : Chipswap.DiscoverNeutronContactsRequestV2
            ) : Chipswap.DiscoverNeutronContactsResultV2 {
                #ok({ book_revision = 1; contacts = []; total = 0; next_offset = null });
            };
        };
    };
    capabilities = {
        backend_calls = {
            canister_principal = who;
            can_call = func(_canister : Principal, _method : Text) : Bool { true };
            call = func(
                _request : NeutronCapabilities.BackendCallRequestV1
            ) : async* NeutronCapabilities.BackendCallResultV1 {
                #err({ code = "unused"; message = "unused" });
            };
            call_batch = func(
                _requests : [NeutronCapabilities.BackendCallRequestV1]
            ) : async* [NeutronCapabilities.BackendCallResultV1] { [] };
        };
    };
};

let environment = environmentFor(memory, self);
let chipswap = Chipswap.Init(environment);

// A fresh installation reports its own address and an empty studio.
let initial = chipswap.chipswap_status(());
assert (initial.canister == Principal.toText(self));
assert (initial.slots_used == 0);
assert (initial.slot_limit == 10);
assert (initial.holdings == 0);
assert (initial.pixel_count == Shape.PIXEL_COUNT);
assert (initial.row_widths.size() == 31);
assert (initial.contacts_available);

// Create and publish one auto-accepting design.
let created = switch (chipswap.chipswap_draft_create({ title = "Sunrise" })) {
    case (#ok(value)) value;
    case (#err(error)) Runtime.trap("create: " # error.code);
};
assert (created.design_id == 1);

let designs = chipswap.chipswap_designs(());
assert (designs.size() == 1);
assert (designs[0].state == "draft");
assert (designs[0].art.palette.size() >= 1);
assert (designs[0].art.pixels.size() == Shape.PIXEL_COUNT * 2);
// The owner-facing art form is text, never Candid blobs.
assert (designs[0].art.palette[0].size() == 7);

// Saving enforces the expected revision and validates the art.
switch (
    chipswap.chipswap_draft_save({
        design_id = 1;
        expected_revision = 1;
        title = "Sunrise";
        palette = ["#101010", "#ffffff"];
        pixels = designs[0].art.pixels;
    })
) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("save: " # error.code);
};
switch (
    chipswap.chipswap_draft_save({
        design_id = 1;
        expected_revision = 1;
        title = "Stale";
        palette = ["#101010"];
        pixels = designs[0].art.pixels;
    })
) {
    case (#ok(_)) Runtime.trap("expected a revision conflict");
    case (#err(error)) assert (error.code == "revision_conflict");
};
switch (
    chipswap.chipswap_draft_save({
        design_id = 1;
        expected_revision = 2;
        title = "Bad color";
        palette = ["101010"];
        pixels = designs[0].art.pixels;
    })
) {
    case (#ok(_)) Runtime.trap("expected a palette error");
    case (#err(error)) assert (error.code == "palette_invalid");
};

// Published with one requirement about the artwork and one about the tag, so
// the catalog, the store, and the trade route all have something to carry.
switch (
    chipswap.chipswap_publish({
        design_id = 1;
        expected_revision = 2;
        approval = false;
        min_colors = ?2;
        max_coverage = null;
        nsfw_rule = "disallowed";
        nsfw = false;
    })
) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("publish: " # error.code);
};

// Publishing puts the design in our own collection. It is not a holding — no
// slot is spent, and there is nothing to trade away — but it is ours, so it
// leads the page ahead of anything we collected.
let ownDesigns = chipswap.chipswap_collection({ offset = 0; limit = 10 });
assert (ownDesigns.total == 1);
assert (ownDesigns.chips[0].origin == "design");
assert (ownDesigns.chips[0].designer == Principal.toText(self));
assert (ownDesigns.chips[0].design_id == 1);
assert (ownDesigns.chips[0].serial == 0);
assert (ownDesigns.chips[0].minted_count == 0);
assert (ownDesigns.chips[0].state == "held");
assert (ownDesigns.chips[0].peer == null);
assert (ownDesigns.chips[0].request_id == null);
assert (chipswap.chipswap_status(()).holdings == 0);

// A draft is not a chip. Only what has been published shows up, because only
// that is something a peer could ever hold.
switch (chipswap.chipswap_draft_create({ title = "Unfinished" })) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("draft: " # error.code);
};
assert (chipswap.chipswap_collection({ offset = 0; limit = 10 }).total == 1);
switch (chipswap.chipswap_draft_delete({ design_id = 2 })) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("draft_delete: " # error.code);
};

// A requirement that restricts nothing is refused, and so is a rule that is
// not one of the three.
switch (
    chipswap.chipswap_set_trade_policy({
        design_id = 1;
        approval = false;
        min_colors = ?1;
        max_coverage = null;
        nsfw_rule = "any";
        nsfw = false;
    })
) {
    case (#ok(_)) Runtime.trap("expected a requirements error");
    case (#err(error)) assert (error.code == "requirements_invalid");
};
switch (
    chipswap.chipswap_set_trade_policy({
        design_id = 1;
        approval = false;
        min_colors = null;
        max_coverage = null;
        nsfw_rule = "maybe";
        nsfw = false;
    })
) {
    case (#ok(_)) Runtime.trap("expected an NSFW rule error");
    case (#err(error)) assert (error.code == "nsfw_rule_invalid");
};

// A peer asks for the catalog: only published designs travel, in CSW1 form.
let catalogBytes = chipswap.chipswap_catalog_v1({}, peer);
let ?catalog = Wire.decodeCatalogReply(catalogBytes) else Runtime.trap("catalog decode");
assert (catalog.designs.size() == 1);
assert (catalog.designs[0].design_id == 1);
assert (not catalog.designs[0].requirements.approval);
assert (catalog.designs[0].requirements.min_colors == ?2);
assert (catalog.designs[0].requirements.nsfw == ? #disallowed);
assert (not catalog.designs[0].nsfw);
assert (catalog.designs[0].art.pixels.size() == Shape.PIXEL_COUNT);

// The peer trades one of their chips for it. Auto mode answers in one call.
let offered : Chipswap.PeerChip = {
    designer = peer;
    design_id = 3;
    serial = 8;
    title = "Peer chip";
    art = {
        shape_id = Shape.SHAPE_ID;
        palette = [0x000000, 0xffffff];
        pixels = Blob.fromArray(
            Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(i) { Nat8.fromNat(i % 2) })
        );
    };
    nsfw = false;
    design_revision = 1;
    minted_at_ns = 5;
};
let requestId = Blob.fromArray(Array.tabulate<Nat8>(16, func(i) { Nat8.fromNat(i) }));
let tradeBytes = chipswap.chipswap_trade_v1(
    {
        request_id = requestId;
        want_design_id = 1;
        offered;
    },
    peer,
);
let ?tradeReply = Wire.decodeTradeReply(tradeBytes) else Runtime.trap("trade decode");
let mintedSerial = switch (tradeReply) {
    case (#minted(payload)) {
        assert (payload.chip.designer == self);
        assert (payload.chip.design_id == 1);
        payload.chip.serial;
    };
    case (_) Runtime.trap("expected a minted reply");
};
assert (mintedSerial == 1);

// Their chip is in our collection, and the peer is in our directory. Our own
// design still leads: the chip we just took in sits behind it.
let collection = chipswap.chipswap_collection({ offset = 0; limit = 10 });
assert (collection.total == 2);
assert (collection.chips[0].origin == "design");
assert (collection.chips[0].design_id == 1);
// Minting for the peer is the one thing that moves an own design's counter.
assert (collection.chips[0].minted_count == 1);
assert (collection.chips[1].origin == "held");
assert (collection.chips[1].designer == Principal.toText(peer));
assert (collection.chips[1].state == "held");
assert (collection.chips[1].serial == 8);
assert (collection.chips[1].minted_count == 0);

// Paging counts both kinds in one sequence, so a window can straddle them.
let firstOnly = chipswap.chipswap_collection({ offset = 0; limit = 1 });
assert (firstOnly.total == 2);
assert (firstOnly.chips.size() == 1);
assert (firstOnly.chips[0].origin == "design");
let heldOnly = chipswap.chipswap_collection({ offset = 1; limit = 1 });
assert (heldOnly.total == 2);
assert (heldOnly.chips.size() == 1);
assert (heldOnly.chips[0].origin == "held");
assert (chipswap.chipswap_collection({ offset = 2; limit = 10 }).chips.size() == 0);
let directory = chipswap.chipswap_directory({ offset = 0; limit = 10 });
assert (directory.total == 1);
assert (directory.entries[0].canister == Principal.toText(peer));
assert (directory.entries[0].source == "trade");
assert (not directory.entries[0].ignored);

// Reading our catalog does not put the reader here. Browsing is not a
// relationship; proposing a trade is, which is why the peer above is listed and
// this one is not.
let browser = Principal.fromBlob(Blob.fromArray([0, 4, 4, 1]));
let beforeBrowse = chipswap.chipswap_status(()).revision;
ignore chipswap.chipswap_catalog_v1({}, browser);
assert (chipswap.chipswap_directory({ offset = 0; limit = 10 }).total == 1);
// Nor does it leave a trace in the revision the tile polls. A catalog read is
// a query: it writes nothing, so there is nothing for the owner's tile to
// notice about a stranger's curiosity.
assert (chipswap.chipswap_status(()).revision == beforeBrowse);

// Replaying the same request returns the same chip without minting again.
let replayBytes = chipswap.chipswap_trade_v1(
    { request_id = requestId; want_design_id = 1; offered },
    peer,
);
let ?replayReply = Wire.decodeTradeReply(replayBytes) else Runtime.trap("replay decode");
switch (replayReply) {
    case (#minted(payload)) assert (payload.chip.serial == mintedSerial);
    case (_) Runtime.trap("expected a replayed mint");
};
assert (chipswap.chipswap_collection({ offset = 0; limit = 10 }).total == 2);

// The status route answers the proposer's later question.
let statusBytes = chipswap.chipswap_status_v1({ request_id = requestId }, peer);
let ?statusReply = Wire.decodeStatusReply(statusBytes) else Runtime.trap("status decode");
switch (statusReply) {
    case (#minted(payload)) assert (payload.chip.serial == mintedSerial);
    case (_) Runtime.trap("expected a minted status");
};
// A different caller learns nothing about someone else's trade.
let otherBytes = chipswap.chipswap_status_v1({ request_id = requestId }, self);
assert (Wire.decodeStatusReply(otherBytes) == ?#unknown);

// A peer crawls us: one page of the designers we know, with the total so they
// can tell whether to ask again.
let pageBytes = chipswap.chipswap_directory_v1({ offset = 0; limit = 10 }, peer);
let ?pageReply = Wire.decodeDirectoryReply(pageBytes) else Runtime.trap("directory decode");
assert (pageReply.total == 1);
assert (pageReply.entries[0] == peer);

// A limit of zero, or one past the cap, is answered with the cap rather than
// with nothing: a caller who asks badly still gets a usable page.
let cappedBytes = chipswap.chipswap_directory_v1({ offset = 0; limit = 0 }, peer);
let ?cappedReply = Wire.decodeDirectoryReply(cappedBytes) else Runtime.trap("capped decode");
assert (cappedReply.entries.size() == 1);
let hugeBytes = chipswap.chipswap_directory_v1({ offset = 0; limit = 100_000 }, peer);
let ?hugeReply = Wire.decodeDirectoryReply(hugeBytes) else Runtime.trap("huge decode");
assert (hugeReply.entries.size() == 1);

// Past the end is an empty page rather than a refusal, which is how a crawler
// learns it has finished.
let pastBytes = chipswap.chipswap_directory_v1({ offset = 50; limit = 10 }, peer);
let ?pastReply = Wire.decodeDirectoryReply(pastBytes) else Runtime.trap("past decode");
assert (pastReply.entries.size() == 0);
assert (pastReply.total == 1);

// We never hand anyone our own address.
for (candidate in pageReply.entries.values()) assert (candidate != self);

// A delivery for a trade we never proposed is refused.
let deliverBytes = chipswap.chipswap_deliver_v1(
    {
        request_id = requestId;
        outcome = #declined;
    },
    peer,
);
switch (Wire.decodeDeliverReply(deliverBytes)) {
    case (?#err(payload)) assert (payload.code == "unknown_trade");
    case (_) Runtime.trap("expected unknown_trade");
};

// Owner-supplied principals are parsed without trapping.
switch (chipswap.chipswap_directory_add({ canister = "not-a-principal"; source = "manual" })) {
    case (#ok(_)) Runtime.trap("expected a principal error");
    case (#err(error)) assert (error.code == "principal_invalid");
};
switch (
    chipswap.chipswap_directory_add({
        canister = Principal.toText(self);
        source = "manual";
    })
) {
    case (#ok(_)) Runtime.trap("expected a self entry error");
    case (#err(error)) assert (error.code == "self_entry");
};
switch (
    chipswap.chipswap_directory_add({
        canister = Principal.toText(peer);
        source = "contacts";
    })
) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("directory_add: " # error.code);
};

// Ignoring is a directory edit the owner can undo, and it is only ever applied
// to a designer already known: there is nothing to ignore otherwise.
switch (chipswap.chipswap_directory_set_ignored({ canister = "not-a-principal"; ignored = true })) {
    case (#ok(_)) Runtime.trap("expected a principal error");
    case (#err(error)) assert (error.code == "principal_invalid");
};
switch (
    chipswap.chipswap_directory_set_ignored({
        canister = Principal.toText(self);
        ignored = true;
    })
) {
    case (#ok(_)) Runtime.trap("expected a miss");
    case (#err(error)) assert (error.code == "not_found");
};
assert (chipswap.chipswap_directory({ offset = 0; limit = 10 }).entries[0].ignored == false);
switch (
    chipswap.chipswap_directory_set_ignored({
        canister = Principal.toText(peer);
        ignored = true;
    })
) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("set_ignored: " # error.code);
};
let ignoredPage = chipswap.chipswap_directory({ offset = 0; limit = 10 });
// Still listed, still ours to un-ignore. Forgetting them would let the next
// exchange hand them straight back with no memory of the decision.
assert (ignoredPage.total == 1);
assert (ignoredPage.entries[0].canister == Principal.toText(peer));
assert (ignoredPage.entries[0].ignored);
switch (
    chipswap.chipswap_directory_set_ignored({
        canister = Principal.toText(peer);
        ignored = false;
    })
) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("set_ignored: " # error.code);
};
assert (chipswap.chipswap_directory({ offset = 0; limit = 10 }).entries[0].ignored == false);

// Brushes persist with validated geometry.
switch (
    chipswap.chipswap_brush_save({
        id = null;
        name = "L";
        width = 3;
        height = 3;
        anchor_x = 0;
        anchor_y = 0;
        cells = "010001000101";
    })
) {
    case (#ok(_)) Runtime.trap("expected a cell-count error");
    case (#err(error)) assert (error.code == "brush_invalid");
};
switch (
    chipswap.chipswap_brush_save({
        id = null;
        name = "L";
        width = 3;
        height = 3;
        anchor_x = 0;
        anchor_y = 0;
        cells = "010000010000010101";
    })
) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("brush_save: " # error.code);
};
let brushes = chipswap.chipswap_brushes(());
assert (brushes.size() == 1);
assert (brushes[0].name == "L");
assert (brushes[0].cells.size() == 18);
switch (chipswap.chipswap_brush_delete({ id = brushes[0].id })) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("brush_delete: " # error.code);
};
assert (chipswap.chipswap_brushes(()).size() == 0);

// Every mutation advances the revision the tile polls.
let finalStatus = chipswap.chipswap_status(());
assert (finalStatus.revision > initial.revision);
assert (finalStatus.published_count == 1);
assert (finalStatus.holdings == 1);
assert (finalStatus.directory_count == 1);


// --- The record a finished trade leaves --------------------------------------

// The ledger is read through its own call rather than riding along with
// chipswap_trades, which the tile polls for the pending badge.
let ledgerMemory = Memory.init();
let ledger = Chipswap.Init(environmentFor(ledgerMemory, self));
assert (ledger.chipswap_trade_history({ offset = 0; limit = 20 }).total == 0);

let tradedId = Trades.recordHistory(
    ledgerMemory,
    #outgoing,
    peer,
    "\01\02",
    3,
    ?{ title = "Bluebird"; ref = { designer = self; design_id = 1; serial = 2 } },
    ?{ title = "Ember"; ref = { designer = peer; design_id = 3; serial = 9 } },
    null,
    #traded,
    100,
    200,
);
let stuckId = Trades.recordHistory(
    ledgerMemory,
    #outgoing,
    peer,
    "\03\04",
    4,
    ?{ title = "Ash"; ref = { designer = self; design_id = 2; serial = 1 } },
    null,
    ?"escrowed-chip",
    #unresolved,
    300,
    400,
);

// Newest first, and both sides of the swap come through named.
let ledgerPage = ledger.chipswap_trade_history({ offset = 0; limit = 20 });
assert (ledgerPage.total == 2);
assert (ledgerPage.entries[0].entry_id == stuckId);
assert (ledgerPage.entries[0].outcome == "unresolved");
assert (ledgerPage.entries[1].outcome == "traded");
assert (ledgerPage.entries[1].direction == "outgoing");
switch (ledgerPage.entries[1].ours) {
    case (?chip) assert (chip.title == "Bluebird");
    case null Runtime.trap("our side did not reach the view");
};
switch (ledgerPage.entries[1].theirs) {
    case (?chip) assert (chip.serial == 9);
    case null Runtime.trap("their side did not reach the view");
};
// A trade with nothing on the other side says so rather than inventing one.
assert (ledgerPage.entries[0].theirs == null);

// Clearing takes the settled rows and leaves the unresolved one, because that
// entry is the last thing naming a chip that is still committed to a trade.
switch (ledger.chipswap_history_clear(())) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("history_clear: " # error.code);
};
let afterClear = ledger.chipswap_trade_history({ offset = 0; limit = 20 });
assert (afterClear.total == 1);
assert (afterClear.entries[0].entry_id == stuckId);

// By hand it can still go: the owner may genuinely want it gone.
switch (ledger.chipswap_history_forget({ entry_id = stuckId })) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("history_forget: " # error.code);
};
assert (ledger.chipswap_trade_history({ offset = 0; limit = 20 }).total == 0);

// A record that was never here is named as such rather than quietly accepted.
switch (ledger.chipswap_history_forget({ entry_id = 99_999 })) {
    case (#ok(_)) Runtime.trap("forgetting a missing record should fail");
    case (#err(error)) assert (error.code == "unknown_entry");
};

// Only a trade with an unconfirmed outcome can be set aside, and only one that
// is actually here.
switch (ledger.chipswap_trade_abandon({ request_id = "0102" })) {
    case (#ok(_)) Runtime.trap("abandoning an unknown trade should fail");
    case (#err(error)) assert (error.code == "unknown_trade");
};
ignore tradedId;

// --- What an install starts with ---------------------------------------------

// A clean install can reach the rest of the graph. Every route to a new
// designer — fetching a catalog, crawling, being proposed a trade — needs
// somebody already in the table, so one address ships with the app and an empty
// directory is never what an owner is handed.
let freshMemory = Memory.init();
let fresh = Chipswap.Init(environmentFor(freshMemory, peer));
let freshPage = fresh.chipswap_directory({ offset = 0; limit = 10 });
assert (freshPage.total == 1);
assert (freshPage.entries[0].canister == "3wvx3-yaaaa-aaaay-aacuq-cai");
assert (freshPage.entries[0].source == "seed");
assert (not freshPage.entries[0].ignored);
assert (fresh.chipswap_status(()).directory_count == 1);

// Installed on the seeded canister itself, that address is this canister's own.
// A Neutron cannot trade with itself, cannot crawl itself, and is already
// filtered out of the page it serves peers, so the entry is not a designer at
// all — it is a row that could only ever mislead. It goes.
let ownMemory = Memory.init();
let own = Chipswap.Init(environmentFor(ownMemory, Memory.seedDesigner()));
assert (own.chipswap_directory({ offset = 0; limit = 10 }).total == 0);
assert (own.chipswap_status(()).directory_count == 0);

// Which is the same rule `chipswap_directory_add` already enforces by hand, and
// it survives the upgrade that re-runs this: constructing again over the same
// memory leaves nothing behind to clean up.
let again = Chipswap.Init(environmentFor(ownMemory, Memory.seedDesigner()));
assert (again.chipswap_directory({ offset = 0; limit = 10 }).total == 0);

// --- The propose-time catalog check -----------------------------------------

// There is no stored catalog to consult any more, so chipswap_trade_propose
// asks the peer before it mints. The decision that check makes is this
// function, and every way it can say no is a chip not spent.
let checkArt : Wire.Art = {
    shape_id = Shape.SHAPE_ID;
    palette = [0x000000];
    pixels = Blob.fromArray(Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(_) { 0 }));
};

func publishedByPeer(id : Nat) : Wire.Design {
    {
        design_id = id;
        title = "Peer chip";
        art = checkArt;
        requirements = {
            approval = false;
            min_colors = null;
            max_coverage = null;
            nsfw = null;
        };
        nsfw = false;
        design_revision = 1;
        published_at_ns = 5;
    };
};

let peerCatalog : Wire.CatalogReply = { designs = [publishedByPeer(1), publishedByPeer(4)] };

// A design the peer really publishes is the only case that proceeds.
assert (Chipswap.publishesDesign(?peerCatalog, 1));
assert (Chipswap.publishesDesign(?peerCatalog, 4));

// One they do not publish does not, however plausible the id looks. This is
// the stale-browser-cache case: the tile offered a row that is no longer real.
assert (Chipswap.publishesDesign(?peerCatalog, 2) == false);
assert (Chipswap.publishesDesign(?peerCatalog, 0) == false);

// A designer who has published nothing yet.
assert (Chipswap.publishesDesign(?{ designs = [] }, 1) == false);

// No answer at all — unreachable, rejected, or a reply we could not decode.
// Silence is not permission: a peer that will not answer a free query would
// not have answered the paid call either, and refusing here costs no chip.
assert (Chipswap.publishesDesign(null, 1) == false);
