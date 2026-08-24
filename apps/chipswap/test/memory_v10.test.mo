import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import V9 "../backend/memory/chipswap/v9";
import V10 "../backend/memory/chipswap/v10";
import Migrate "../backend/memory/chipswap/v9_to_v10";

// V10 gives a directory entry somewhere to record the chips of that designer's
// the owner has turned away. Until now the only judgement the table could hold
// about a designer was the whole-catalogue `ignored` flag, so a reader tired of
// two chips had to choose between keeping the whole catalogue on screen and
// losing all of it.
//
// The list lives on the entry rather than in a root of its own so that removing
// a designer takes their ignored chips with them, ignoring a designer leaves
// them intact to be restored, and the table cannot outgrow the directory.

let alice = Principal.fromBlob("\00\01\01");
let bob = Principal.fromBlob("\00\02\01");

let old = V9.init();
old.revision := 12;
old.next_request_seq := 5;
old.next_brush_id := 2;
old.next_history_id := 7;

func remember(canister : Principal, ignored : Bool, seen : Int) {
    Map.add(
        old.directory,
        Principal.compare,
        canister,
        {
            canister;
            source = #manual;
            first_seen_ns = seen;
            last_seen_ns = seen + 5;
            ignored;
        } : V9.DirectoryEntry,
    );
};

remember(alice, false, 100);
remember(bob, true, 200);

let fresh : V10.Mem = Migrate.migrate(old);

// Scalars carry across untouched.
if (fresh.revision != 12) Runtime.trap("revision did not carry across");
if (fresh.next_request_seq != 5) Runtime.trap("request sequence did not carry across");
if (fresh.next_brush_id != 2) Runtime.trap("brush id did not carry across");
if (fresh.next_history_id != 7) Runtime.trap("history id did not carry across");

// Every designer the owner knew is still known, seed included.
if (Map.size(fresh.directory) != Map.size(old.directory)) {
    Runtime.trap("the migration lost a designer");
};

// Nobody has ignored a chip before this release, so an empty list is the truth
// about every existing entry rather than a default standing in for data that
// was lost.
for ((canister, entry) in Map.entries(fresh.directory)) {
    if (entry.ignored_designs.size() != 0) {
        Runtime.trap("the migration invented an ignored chip");
    };
};

// The rest of an entry is untouched, the standing designer-level ignore most of
// all: it is the owner's decision and a migration is not the place to revisit it.
let ?carried = Map.get(fresh.directory, Principal.compare, alice) else {
    Runtime.trap("a known designer was dropped");
};
if (carried.source != #manual) Runtime.trap("an entry lost how we met the designer");
if (carried.first_seen_ns != 100) Runtime.trap("an entry lost when we met the designer");
if (carried.last_seen_ns != 105) Runtime.trap("an entry lost when we last saw the designer");
if (carried.ignored) Runtime.trap("the migration ignored a designer nobody ignored");

let ?turnedAway = Map.get(fresh.directory, Principal.compare, bob) else {
    Runtime.trap("an ignored designer was dropped");
};
if (not turnedAway.ignored) Runtime.trap("the migration reinstated an ignored designer");

// Every other root passes through by reference: this schema changes one field
// on one type, and a migration that rebuilt the rest could only lose something.
if (Map.size(fresh.designs) != Map.size(old.designs)) Runtime.trap("designs did not carry across");
if (Map.size(fresh.holdings) != Map.size(old.holdings)) Runtime.trap("holdings did not carry across");
if (Map.size(fresh.incoming) != Map.size(old.incoming)) Runtime.trap("incoming did not carry across");
if (Map.size(fresh.outgoing) != Map.size(old.outgoing)) Runtime.trap("outgoing did not carry across");
if (Map.size(fresh.replay) != Map.size(old.replay)) Runtime.trap("replay did not carry across");
if (Map.size(fresh.history) != Map.size(old.history)) Runtime.trap("history did not carry across");
if (List.size(fresh.brushes) != List.size(old.brushes)) Runtime.trap("brushes did not carry across");

// An emptied directory is still empty afterwards: the migration walks what is
// there rather than putting anything back.
let emptied = V9.init();
Map.clear(emptied.directory);
if (Map.size(Migrate.migrate(emptied).directory) != 0) {
    Runtime.trap("the migration reinstated a directory the owner had emptied");
};

// A clean V10 install starts with the seed designer, ignoring none of its chips.
let clean = V10.init();
if (Map.size(clean.directory) != 1) Runtime.trap("V10 install lost its seed");
let ?seed = Map.get(clean.directory, Principal.compare, V10.seedDesigner()) else {
    Runtime.trap("V10 seed is not the seed designer");
};
if (seed.source != #seed) Runtime.trap("V10 seed does not say it is a seed");
if (seed.ignored) Runtime.trap("V10 seed arrives ignored");
if (seed.ignored_designs.size() != 0) Runtime.trap("V10 seed arrives with a chip turned away");
if (clean.revision != 0) Runtime.trap("V10 install did not start at revision zero");
if (clean.next_history_id != 1) Runtime.trap("V10 install does not start ids at one");
if (Map.size(clean.designs) != 0) Runtime.trap("V10 install invented designs");
if (Map.size(clean.history) != 0) Runtime.trap("V10 install invented history");
if (List.size(clean.brushes) != 0) Runtime.trap("V10 install invented brushes");
