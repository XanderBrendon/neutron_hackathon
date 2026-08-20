import Map "mo:core/Map";
import Principal "mo:core/Principal";
import V4 "./v4";
import V5 "./v5";

// V5 adds one source variant and one clean-install default. Neither is
// something an upgrade applies.
//
// A directory that already exists is the owner's, entry by entry: each one is
// there because they typed it in, added it from Contacts, was proposed a trade,
// or ran a crawl. Seeding on top of that would hand an address to someone who
// never asked for one, and re-add a designer whose absence was a decision. So
// every entry carries across as itself, an empty directory stays empty, and
// `#seed` appears only in a directory that `V5.init()` built.
//
// The rebuild below is a retyping, not a rewrite. `Map` is invariant in its
// value type, so a `Map.Map<Principal, V4.DirectoryEntry>` cannot be used where
// a `Map.Map<Principal, V5.DirectoryEntry>` is wanted even though every entry
// in it already is one — V4's four-variant source is a subtype of V5's five.
// Every other root is unchanged at both versions and passes through untouched.
module {
    public func migrate(old : V4.Mem) : V5.Mem {
        let directory = Map.empty<Principal, V5.DirectoryEntry>();
        for ((canister, entry) in Map.entries(old.directory)) {
            Map.add(directory, Principal.compare, canister, entry);
        };

        {
            var revision = old.revision;
            var next_request_seq = old.next_request_seq;
            var next_brush_id = old.next_brush_id;
            var crawl = null;
            designs = old.designs;
            holdings = old.holdings;
            directory;
            catalog_cache = old.catalog_cache;
            incoming = old.incoming;
            outgoing = old.outgoing;
            replay = old.replay;
            brushes = old.brushes;
        };
    };
};
