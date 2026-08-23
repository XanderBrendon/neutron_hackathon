import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import V7 "../backend/memory/chipswap/v7";
import V8 "../backend/memory/chipswap/v8";
import Migrate "../backend/memory/chipswap/v7_to_v8";

// V8 removes retirement. `retired` was a conclusion this canister drew from
// three unanswered paid calls and `strikes` was the evidence behind it; both go
// because the app no longer concludes anything about a designer. A peer that
// does not answer is now put in front of the owner, next to the two things they
// might do about it.
//
// The migration therefore drops the flag rather than translating it. A designer
// it had retired comes out an ordinary entry and is asked again — which is the
// point: if they really are gone, the next catalog read says so by name.

let alice = Principal.fromBlob("\00\01\01");
let bob = Principal.fromBlob("\00\02\01");

let old = V7.init();
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
    } : V7.DirectoryEntry,
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
    } : V7.DirectoryEntry,
);

let seeded = Map.size(old.directory);
let fresh : V8.Mem = Migrate.migrate(old);

if (fresh.revision != 42) Runtime.trap("revision did not carry across");
if (fresh.next_request_seq != 7) Runtime.trap("request sequence did not carry across");
if (fresh.next_brush_id != 3) Runtime.trap("brush id did not carry across");
if (Map.size(fresh.directory) != seeded) Runtime.trap("directory changed size");

// A retired designer is not removed and not silenced. They come back into
// rotation as an ordinary entry, keeping how we met them and when.
let ?entry = Map.get(fresh.directory, Principal.compare, alice) else Runtime.trap("alice missing");
if (entry.source != #manual) Runtime.trap("alice lost her source");
if (entry.first_seen_ns != 10 or entry.last_seen_ns != 20) Runtime.trap("alice lost her timestamps");
if (entry.ignored) Runtime.trap("a retirement was relabelled as the owner's ignore");

// An ignore is the owner's standing instruction, and the only one of the two
// flags that ever was. It survives.
let ?other = Map.get(fresh.directory, Principal.compare, bob) else Runtime.trap("bob missing");
if (not other.ignored) Runtime.trap("bob lost his ignore");
if (other.source != #crawl) Runtime.trap("bob lost his source");

// A clean V8 install still starts knowing the seed designer: every route to a
// new designer needs one already in the table to start from.
let clean = V8.init();
if (Map.size(clean.directory) != 1) Runtime.trap("V8 install lost its seed");
let ?seed = Map.get(clean.directory, Principal.compare, V8.seedDesigner()) else {
    Runtime.trap("V8 seed is not the seed designer");
};
if (seed.source != #seed) Runtime.trap("V8 seed does not say it is a seed");
if (seed.ignored) Runtime.trap("V8 seed arrives ignored");
if (seed.first_seen_ns != 0 or seed.last_seen_ns != 0) {
    Runtime.trap("V8 seed claims to have been seen");
};

// Nothing else about a clean install changed.
if (clean.revision != 0) Runtime.trap("V8 install did not start at revision zero");
if (clean.next_request_seq != 1) Runtime.trap("V8 install lost its request sequence");
if (Map.size(clean.designs) != 0) Runtime.trap("V8 install invented designs");
if (Map.size(clean.holdings) != 0) Runtime.trap("V8 install invented holdings");
if (List.size(clean.brushes) != 0) Runtime.trap("V8 install invented brushes");
