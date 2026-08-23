import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import V6 "../backend/memory/chipswap/v6";
import V7 "../backend/memory/chipswap/v7";
import Migrate "../backend/memory/chipswap/v6_to_v7";

// V7 removes the crawl. The migration is a projection: the walk is dropped
// because it describes a moment, and everything the owner actually owns —
// their directory above all — carries across untouched.

let alice = Principal.fromBlob("\00\01\01");
let bob = Principal.fromBlob("\00\02\01");

let old = V6.init();
old.revision := 42;
old.next_request_seq := 7;
old.next_brush_id := 3;

Map.add(
    old.directory,
    Principal.compare,
    alice,
    {
        canister = alice;
        source = #manual;
        first_seen_ns = 10;
        last_seen_ns = 20;
        ignored = false;
        retired = true;
        strikes = 3;
    } : V6.DirectoryEntry,
);
Map.add(
    old.directory,
    Principal.compare,
    bob,
    {
        canister = bob;
        source = #crawl;
        first_seen_ns = 30;
        last_seen_ns = 40;
        ignored = true;
        retired = false;
        strikes = 0;
    } : V6.DirectoryEntry,
);

// Upgrading mid-walk is the case the migration exists to survive. A canister
// with a crawl in flight is exactly what the install transaction may find.
let running : V6.Crawl = {
    started_at_ns = 900;
    var queried = 4;
    var discovered = 2;
    visited = Set.empty<Principal>();
    cursors = Map.empty<Principal, Nat>();
};
Set.add(running.visited, Principal.compare, alice);
Map.add(running.cursors, Principal.compare, bob, 128);
old.crawl := ?running;

let seeded = Map.size(old.directory);
let fresh : V7.Mem = Migrate.migrate(old);

if (fresh.revision != 42) Runtime.trap("revision did not carry across");
if (fresh.next_request_seq != 7) Runtime.trap("request sequence did not carry across");
if (fresh.next_brush_id != 3) Runtime.trap("brush id did not carry across");
if (Map.size(fresh.directory) != seeded) Runtime.trap("directory changed size");

// Every judgement about a designer is the owner's, and none of it was the
// crawl's to take with it.
let ?entry = Map.get(fresh.directory, Principal.compare, alice) else Runtime.trap("alice missing");
if (entry.source != #manual) Runtime.trap("alice lost her source");
if (entry.first_seen_ns != 10 or entry.last_seen_ns != 20) Runtime.trap("alice lost her timestamps");
if (entry.strikes != 3) Runtime.trap("alice lost her strikes");
if (not entry.retired) Runtime.trap("alice lost her retirement");
if (entry.ignored) Runtime.trap("alice gained an ignore");

// An ignore is a standing instruction. A designer the owner silenced while a
// crawl was running must not come back because the crawl went away.
let ?other = Map.get(fresh.directory, Principal.compare, bob) else Runtime.trap("bob missing");
if (not other.ignored) Runtime.trap("bob lost his ignore");
// A designer a crawl introduced is still one a crawl introduced.
if (other.source != #crawl) Runtime.trap("bob lost his source");

// A clean V7 install still starts knowing the seed designer: a crawl needs
// somewhere to walk out from, and that is now true of the browser's crawl.
let clean = V7.init();
if (Map.size(clean.directory) != 1) Runtime.trap("V7 install lost its seed");
let ?seed = Map.get(clean.directory, Principal.compare, V7.seedDesigner()) else {
    Runtime.trap("V7 seed is not the seed designer");
};
if (seed.source != #seed) Runtime.trap("V7 seed does not say it is a seed");
if (seed.first_seen_ns != 0 or seed.last_seen_ns != 0) {
    Runtime.trap("V7 seed claims to have been seen");
};

// Nothing else about a clean install changed.
if (clean.revision != 0) Runtime.trap("V7 install did not start at revision zero");
if (clean.next_request_seq != 1) Runtime.trap("V7 install lost its request sequence");
if (Map.size(clean.designs) != 0) Runtime.trap("V7 install invented designs");
if (Map.size(clean.holdings) != 0) Runtime.trap("V7 install invented holdings");
if (List.size(clean.brushes) != 0) Runtime.trap("V7 install invented brushes");
