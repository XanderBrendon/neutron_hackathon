import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import V8 "../backend/memory/chipswap/v8";
import V9 "../backend/memory/chipswap/v9";
import Migrate "../backend/memory/chipswap/v8_to_v9";

// V9 gives a settled trade somewhere to live. Until now an outgoing trade that
// finished sat in `outgoing` next to the trades still in flight, and an
// incoming one was deleted outright, so the owner could see an offer they made
// weeks ago and never the trade they accepted an hour ago.
//
// The migration is not a reset. Terminal outgoing rows hold real trades and
// they convert; the inbound side starts empty because those rows were already
// deleted and inventing them would put trades in the ledger that this canister
// cannot show ever happened.

let peer = Principal.fromBlob("\00\01\01");

func chipRef(designId : Nat, serial : Nat) : V8.ChipRef {
    { designer = peer; design_id = designId; serial };
};

let old = V8.init();
old.revision := 12;
old.next_request_seq := 5;
old.next_brush_id := 2;

func addOutgoing(key : Text, state : V8.OutgoingState, created : Int) {
    Map.add(
        old.outgoing,
        Text.compare,
        key,
        {
            request_id = "\01\02";
            peer;
            want_design_id = 3;
            offered_key = ?("offered-" # key);
            offered_ref = chipRef(9, 4);
            offered_title = "Offered " # key;
            state;
            created_at_ns = created;
            updated_at_ns = created + 100;
        } : V8.OutgoingTrade,
    );
};

// Two live rows, three settled ones, deliberately out of chronological order.
addOutgoing("live-a", #sending, 500);
addOutgoing("done", #completed(chipRef(3, 7)), 100);
addOutgoing("live-b", #uncertain, 600);
addOutgoing("refused", #declined("designer_declined"), 300);
addOutgoing("broke", #failed("holdings_full"), 200);

let fresh : V9.Mem = Migrate.migrate(old);

// Scalars carry across untouched.
if (fresh.revision != 12) Runtime.trap("revision did not carry across");
if (fresh.next_request_seq != 5) Runtime.trap("request sequence did not carry across");
if (fresh.next_brush_id != 2) Runtime.trap("brush id did not carry across");

// The live table keeps only work in progress.
if (Map.size(fresh.outgoing) != 2) Runtime.trap("live rows did not survive alone");
if (Map.get(fresh.outgoing, Text.compare, "live-a") == null) Runtime.trap("a sending row was dropped");
if (Map.get(fresh.outgoing, Text.compare, "live-b") == null) Runtime.trap("an uncertain row was dropped");

// The settled ones became history, oldest first, with ids from one.
if (Map.size(fresh.history) != 3) Runtime.trap("settled rows did not become history");
if (fresh.next_history_id != 4) Runtime.trap("the next id does not follow the entries");

let entries = Array.sort<(Nat, V9.HistoryEntry)>(
    Map.toArray(fresh.history),
    func(left, right) { Nat.compare(left.0, right.0) },
);

// created_at_ns order: done (100), broke (200), refused (300).
if (entries[0].1.entry_id != 1) Runtime.trap("ids do not start at one");
if (entries[0].1.started_at_ns != 100) Runtime.trap("entries are not in created order");
if (entries[1].1.started_at_ns != 200) Runtime.trap("entries are not in created order");
if (entries[2].1.started_at_ns != 300) Runtime.trap("entries are not in created order");

let completed = entries[0].1;
if (completed.direction != #outgoing) Runtime.trap("a migrated entry lost its direction");
if (completed.outcome != #traded) Runtime.trap("a completed trade is not recorded as traded");
if (completed.settled_at_ns != 200) Runtime.trap("settled time is not the row's updated time");
let ?ours = completed.ours else Runtime.trap("a completed trade forgot our side");
if (ours.title != "Offered done") Runtime.trap("our side lost its title");
if (ours.ref.serial != 4) Runtime.trap("our side lost its ref");
let ?theirs = completed.theirs else Runtime.trap("a completed trade forgot their side");
if (theirs.ref.design_id != 3 or theirs.ref.serial != 7) Runtime.trap("their side lost its ref");
if (completed.escrow_key != ?"offered-done") Runtime.trap("the escrow key did not carry across");

// A declined trade keeps the peer's reason and names no chip on their side,
// because they never minted one.
let refused = entries[2].1;
if (refused.outcome != #declined_by_peer("designer_declined")) {
    Runtime.trap("a declined trade lost its reason");
};
if (refused.theirs != null) Runtime.trap("a declined trade invented a chip");
if (refused.ours == null) Runtime.trap("a declined trade forgot what was offered");

let broke = entries[1].1;
if (broke.outcome != #failed("holdings_full")) Runtime.trap("a failed trade lost its code");

// Nothing reconstructs the inbound side: those rows were deleted on delivery.
for ((_, entry) in Map.entries(fresh.history)) {
    if (entry.direction == #incoming) Runtime.trap("the migration invented an inbound trade");
};

// A clean V9 install starts with an empty ledger and the seed designer intact.
let clean = V9.init();
if (Map.size(clean.history) != 0) Runtime.trap("a clean install invented history");
if (clean.next_history_id != 1) Runtime.trap("a clean install does not start ids at one");
if (Map.size(clean.directory) != 1) Runtime.trap("V9 install lost its seed");
let ?seed = Map.get(clean.directory, Principal.compare, V9.seedDesigner()) else {
    Runtime.trap("V9 seed is not the seed designer");
};
if (seed.source != #seed) Runtime.trap("V9 seed does not say it is a seed");
if (clean.revision != 0) Runtime.trap("V9 install did not start at revision zero");
if (Map.size(clean.designs) != 0) Runtime.trap("V9 install invented designs");
if (List.size(clean.brushes) != 0) Runtime.trap("V9 install invented brushes");
