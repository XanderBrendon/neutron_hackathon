import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Memory "../backend/memory/chipswap/v5";

// V5 is V4 with one difference, and it is the only thing worth asserting here
// that `memory_v4.test.mo` does not already assert about the same shapes: a
// clean install is no longer empty. Every other root still starts at nothing.
//
// An empty directory is a dead end. A designer with nobody to ask cannot fetch
// a catalog, cannot crawl, and cannot trade, so the one address that ships with
// the app is what turns a fresh install into a working one.
let mem = Memory.init();
assert (mem.revision == 0);
assert (mem.next_request_seq == 1);
assert (Map.size(mem.designs) == 0);
assert (Map.size(mem.holdings) == 0);
assert (Map.size(mem.catalog_cache) == 0);
assert (Map.size(mem.incoming) == 0);
assert (Map.size(mem.outgoing) == 0);
assert (Map.size(mem.replay) == 0);
assert (List.size(mem.brushes) == 0);

// The seed, and nothing but the seed.
assert (Map.size(mem.directory) == 1);
let ?seeded = Map.get(mem.directory, Principal.compare, Memory.seedDesigner()) else Runtime.trap("a fresh install has no seed designer");
assert (Principal.toText(seeded.canister) == "3wvx3-yaaaa-aaaay-aacuq-cai");

// `#seed` is its own source because none of the other four is true: the owner
// did not type this address in, nobody proposed a trade, and no crawl found
// them. The tag the directory shows has to be able to say so.
assert (seeded.source == #seed);

// We have never actually heard from this designer, and a timestamp claiming
// otherwise would be a lie the crawl and the catalog refresh would both read.
assert (seeded.first_seen_ns == 0);
assert (seeded.last_seen_ns == 0);
assert (seeded.last_catalog_ns == null);
assert (seeded.design_count == 0);

// It arrives as an ordinary entry with a clean record: ignorable, removable,
// and holding none of the conclusions this canister draws about a peer.
assert (not seeded.ignored);
assert (not seeded.retired);
assert (seeded.strikes == 0);
