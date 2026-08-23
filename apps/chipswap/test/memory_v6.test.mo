import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import V5 "../backend/memory/chipswap/v5";
import V6 "../backend/memory/chipswap/v6";
import Migrate "../backend/memory/chipswap/v5_to_v6";

// V6 removes the peer catalog cache and the two directory fields only it fed.
// The migration is a projection: nothing from the cache is preserved, because
// the browser refetches what used to live there. What must survive is the
// directory itself, which is the owner's and was never the cache's.

let alice = Principal.fromBlob("\00\01\01");
let bob = Principal.fromBlob("\00\02\01");

let old = V5.init();
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
        last_catalog_ns = ?99;
        design_count = 7;
    } : V5.DirectoryEntry,
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
        last_catalog_ns = null;
        design_count = 0;
    } : V5.DirectoryEntry,
);
Map.add(
    old.catalog_cache,
    Principal.compare,
    alice,
    { designer = alice; fetched_at_ns = 99; designs = [] } : V5.CachedCatalog,
);

let seeded = Map.size(old.directory);
let fresh : V6.Mem = Migrate.migrate(old);

if (fresh.revision != 42) Runtime.trap("revision did not carry across");
if (fresh.next_request_seq != 7) Runtime.trap("request sequence did not carry across");
if (fresh.next_brush_id != 3) Runtime.trap("brush id did not carry across");
if (Map.size(fresh.directory) != seeded) Runtime.trap("directory changed size");

let ?entry = Map.get(fresh.directory, Principal.compare, alice) else Runtime.trap("alice missing");
if (entry.source != #manual) Runtime.trap("alice lost her source");
if (entry.first_seen_ns != 10 or entry.last_seen_ns != 20) Runtime.trap("alice lost her timestamps");
if (entry.strikes != 3) Runtime.trap("alice lost her strikes");
if (not entry.retired) Runtime.trap("alice lost her retirement");
if (entry.ignored) Runtime.trap("alice gained an ignore");

// An ignore is a standing instruction, not a cache detail: it must survive a
// migration that drops the cache, or a designer the owner silenced comes back.
let ?other = Map.get(fresh.directory, Principal.compare, bob) else Runtime.trap("bob missing");
if (not other.ignored) Runtime.trap("bob lost his ignore");
if (other.source != #crawl) Runtime.trap("bob lost his source");

// A clean V6 install still starts knowing the seed designer: dropping the
// cache is not a reason to start from an empty graph.
let clean = V6.init();
if (Map.size(clean.directory) != 1) Runtime.trap("V6 install lost its seed");
let ?seed = Map.get(clean.directory, Principal.compare, V6.seedDesigner()) else {
    Runtime.trap("V6 seed is not the seed designer");
};
if (seed.source != #seed) Runtime.trap("V6 seed does not say it is a seed");
if (seed.first_seen_ns != 0 or seed.last_seen_ns != 0) {
    Runtime.trap("V6 seed claims to have been seen");
};
