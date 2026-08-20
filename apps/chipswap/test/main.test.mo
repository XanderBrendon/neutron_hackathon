import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import NeutronCapabilities "mo:neutron-capabilities";
import Chipswap "../backend/main";
import Memory "../backend/memory/chipswap/v3";
import Shape "../backend/Shape";
import Wire "../backend/Wire";

let self = Principal.fromBlob(Blob.fromArray([0, 0, 0, 0, 0, 16, 0, 1, 1, 1]));
let peer = Principal.fromBlob(Blob.fromArray([0, 0, 0, 0, 0, 16, 0, 2, 1, 1]));

let memory = Memory.init();
assert (memory.revision == 0);

// Contacts is a declared install-time dependency; the stub stands in for the
// installed address book.
let environment : Chipswap.AppBackendEnvironment = {
    stable_memory = { chipswap = memory };
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
            canister_principal = self;
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
        title = "Bad colour";
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
let catalogBytes = chipswap.chipswap_catalog_v1({ directory = [] }, peer);
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
        directory = [];
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

// Their chip is in our collection, and the peer is in our directory.
let collection = chipswap.chipswap_collection({ offset = 0; limit = 10 });
assert (collection.total == 1);
assert (collection.chips[0].designer == Principal.toText(peer));
assert (collection.chips[0].state == "held");
assert (collection.chips[0].serial == 8);
let directory = chipswap.chipswap_directory({ offset = 0; limit = 10 });
assert (directory.total == 1);
assert (directory.entries[0].canister == Principal.toText(peer));
assert (directory.entries[0].announced == false);

// Replaying the same request returns the same chip without minting again.
let replayBytes = chipswap.chipswap_trade_v1(
    { request_id = requestId; want_design_id = 1; offered; directory = [] },
    peer,
);
let ?replayReply = Wire.decodeTradeReply(replayBytes) else Runtime.trap("replay decode");
switch (replayReply) {
    case (#minted(payload)) assert (payload.chip.serial == mintedSerial);
    case (_) Runtime.trap("expected a replayed mint");
};
assert (chipswap.chipswap_collection({ offset = 0; limit = 10 }).total == 1);

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

// Announcing adds the caller and returns a directory sample.
let announceBytes = chipswap.chipswap_announce_v1({ directory = [] }, peer);
let ?announceReply = Wire.decodeAnnounceReply(announceBytes) else Runtime.trap("announce decode");
switch (announceReply) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("announce: " # error.code);
};
// A Neutron never announces itself into its own directory.
let selfAnnounce = chipswap.chipswap_announce_v1({ directory = [] }, self);
switch (Wire.decodeAnnounceReply(selfAnnounce)) {
    case (?#err(payload)) assert (payload.code == "self_entry");
    case (_) Runtime.trap("expected self_entry");
};

// A delivery for a trade we never proposed is refused.
let deliverBytes = chipswap.chipswap_deliver_v1(
    {
        request_id = requestId;
        outcome = #declined;
        directory = [];
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

// The store reads the cache, so it is empty until a catalog is fetched.
let store = chipswap.chipswap_store({
    ownership = "all";
    designer_ownership = "all";
    policy = "all";
    nsfw = "hide";
    offset = 0;
    limit = 20;
});
assert (store.total == 0);

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
