import Blob "mo:core/Blob";
import Runtime "mo:core/Runtime";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Set "mo:core/Set";
import Memory "../backend/memory/chipswap/v4";

// A clean install starts empty and every managed root is reachable. This is the
// current schema; `memory.test.mo` holds the same walk over the released V3, so
// a change here that silently drops a root shows up as a difference between the
// two rather than as nothing at all.
let mem = Memory.init();
assert (mem.revision == 0);
assert (mem.next_request_seq == 1);
assert (Map.size(mem.designs) == 0);
assert (Map.size(mem.holdings) == 0);
assert (Map.size(mem.directory) == 0);
assert (Map.size(mem.catalog_cache) == 0);
assert (Map.size(mem.incoming) == 0);
assert (Map.size(mem.outgoing) == 0);
assert (Map.size(mem.replay) == 0);
assert (List.size(mem.brushes) == 0);

let designer = Principal.fromBlob(Blob.fromArray([0, 1, 1]));
let peer = Principal.fromBlob(Blob.fromArray([0, 2, 1]));
let pixels = Blob.fromArray([0, 0, 0]);

let art : Memory.Art = {
    shape_id = "circle31";
    palette = [0x000000, 0xffffff];
    pixels;
};

let design : Memory.Design = {
    design_id = 1;
    title = "First";
    art;
    state = #draft;
    requirements = Memory.openRequirements();
    nsfw = false;
    revision = 1;
    created_at_ns = 10;
    published_at_ns = null;
    next_serial = 1;
};
Map.add(mem.designs, Nat.compare, 1, design);
let ?storedDesign = Map.get(mem.designs, Nat.compare, 1) else Runtime.trap("missing entry");
assert (storedDesign.title == "First");
assert (storedDesign.state == #draft);
// A fresh design asks for nothing: no approval, no requirement, no tag.
assert (not storedDesign.requirements.approval);
assert (storedDesign.requirements.min_colors == null);
assert (storedDesign.requirements.max_coverage == null);
assert (storedDesign.requirements.nsfw == null);
assert (not storedDesign.nsfw);

let chip : Memory.Chip = {
    ref = { designer; design_id = 1; serial = 3 };
    title = "First";
    art;
    nsfw = false;
    design_revision = 1;
    minted_at_ns = 20;
    acquired_at_ns = 21;
    state = #held;
};
Map.add(mem.holdings, Text.compare, "key", chip);
let ?storedChip = Map.get(mem.holdings, Text.compare, "key") else Runtime.trap("missing entry");
assert (storedChip.ref.serial == 3);
assert (storedChip.state == #held);

let entry : Memory.DirectoryEntry = {
    canister = peer;
    source = #manual;
    first_seen_ns = 5;
    last_seen_ns = 6;
    ignored = false;
    retired = false;
    strikes = 0;
    last_catalog_ns = null;
    design_count = 0;
};
Map.add(mem.directory, Principal.compare, peer, entry);
assert (Map.size(mem.directory) == 1);

let cached : Memory.CachedCatalog = {
    designer = peer;
    fetched_at_ns = 30;
    designs = [{
        design_id = 2;
        title = "Peer chip";
        art;
        requirements = {
            approval = true;
            min_colors = ?6;
            max_coverage = ?40;
            nsfw = ? #disallowed;
        };
        nsfw = true;
        design_revision = 4;
        published_at_ns = 12;
    }];
};
Map.add(mem.catalog_cache, Principal.compare, peer, cached);
let ?storedCatalog = Map.get(mem.catalog_cache, Principal.compare, peer) else Runtime.trap("missing entry");
// A cached design carries the whole policy, because the store reads it from
// here and an offer is pre-checked against it before a call is paid for.
assert (storedCatalog.designs[0].requirements.approval);
assert (storedCatalog.designs[0].requirements.min_colors == ?6);
assert (storedCatalog.designs[0].requirements.max_coverage == ?40);
assert (storedCatalog.designs[0].requirements.nsfw == ? #disallowed);
assert (storedCatalog.designs[0].nsfw);

let requestId = Blob.fromArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

let inbound : Memory.IncomingTrade = {
    request_id = requestId;
    peer;
    want_design_id = 1;
    offered = chip;
    state = #pending;
    received_at_ns = 40;
    updated_at_ns = 40;
};
Map.add(mem.incoming, Text.compare, "inbound", inbound);
let ?storedInbound = Map.get(mem.incoming, Text.compare, "inbound") else Runtime.trap("missing entry");
assert (storedInbound.state == #pending);

let outbound : Memory.OutgoingTrade = {
    request_id = requestId;
    peer;
    want_design_id = 2;
    offered_key = ?"key";
    offered_ref = { designer; design_id = 1; serial = 3 };
    offered_title = "First";
    state = #sending;
    created_at_ns = 50;
    updated_at_ns = 50;
};
Map.add(mem.outgoing, Text.compare, "outbound", outbound);
let ?storedOutbound = Map.get(mem.outgoing, Text.compare, "outbound") else Runtime.trap("missing entry");
assert (storedOutbound.state == #sending);

let replay : Memory.ReplayRecord = {
    request_id = requestId;
    peer;
    outcome = #minted({ design_id = 1; serial = 7; nsfw = true });
    recorded_at_ns = 60;
};
Map.add(mem.replay, Text.compare, "replay", replay);
assert (Map.size(mem.replay) == 1);

List.add(
    mem.brushes,
    {
        id = 1;
        name = "L";
        width = 3;
        height = 3;
        anchor_x = 0;
        anchor_y = 0;
        cells = Blob.fromArray([1, 0, 0, 1, 0, 0, 1, 1, 0]);
    } : Memory.CustomBrush,
);
assert (List.size(mem.brushes) == 1);

mem.revision += 1;
mem.next_request_seq += 1;
assert (mem.revision == 1);
assert (mem.next_request_seq == 2);


// --- What V4 adds ------------------------------------------------------------

// Directory entries carry the two conclusions this canister may draw about a
// designer, alongside the one instruction the owner gives.
let listing : Memory.DirectoryEntry = {
    canister = peer;
    source = #crawl;
    first_seen_ns = 10;
    last_seen_ns = 20;
    ignored = false;
    retired = false;
    strikes = 0;
    last_catalog_ns = ?30;
    design_count = 4;
};
Map.add(mem.directory, Principal.compare, peer, listing);
assert (Map.size(mem.directory) == 1);
let ?stored = Map.get(mem.directory, Principal.compare, peer) else Runtime.trap("missing entry");
assert (stored.source == #crawl);
assert (not stored.retired);
assert (stored.strikes == 0);
Map.add(mem.directory, Principal.compare, peer, { listing with retired = true; strikes = 3 });
let ?struck = Map.get(mem.directory, Principal.compare, peer) else Runtime.trap("missing entry");
assert (struck.retired);
assert (struck.strikes == 3);

// A crawl is a root of its own, absent until one is running.
switch (mem.crawl) {
    case null {};
    case (?_) Runtime.trap("a fresh install is not crawling");
};
let crawl : Memory.Crawl = {
    started_at_ns = 100;
    var queried = 0;
    var discovered = 0;
    visited = Set.empty<Principal>();
    cursors = Map.empty<Principal, Nat>();
};
mem.crawl := ?crawl;
let ?running = mem.crawl else Runtime.trap("crawl missing");
Set.add(running.visited, Principal.compare, peer);
Map.add(running.cursors, Principal.compare, designer, 128);
running.queried += 1;
running.discovered += 5;
assert (running.started_at_ns == 100);
assert (running.queried == 1);
assert (running.discovered == 5);
assert (Set.contains(running.visited, Principal.compare, peer));
assert (Map.get(running.cursors, Principal.compare, designer) == ?128);
mem.crawl := null;
switch (mem.crawl) {
    case null {};
    case (?_) Runtime.trap("a stopped crawl left state behind");
};
