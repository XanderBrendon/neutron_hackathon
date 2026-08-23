import Map "mo:core/Map";
import Principal "mo:core/Principal";
import V5 "./v5";
import V6 "./v6";

// The cache is dropped rather than carried: what it held is public, the
// browser refetches it, and a copy left behind would be a stale one nobody
// reads. `design_count` and `last_catalog_ns` described that cache, so they
// leave with it.
//
// The directory itself is the owner's and carries across entry by entry. Every
// field V6 keeps means exactly what it meant at V5 — `ignored` and `retired`
// especially, because both are decisions the owner made or the canister drew,
// and an upgrade that quietly cleared either would put a silenced designer
// back in front of them.
//
// The rebuild below is a retyping, not a rewrite: `Map` is invariant in its
// value type, so a `Map.Map<Principal, V5.DirectoryEntry>` cannot stand in for
// a `Map.Map<Principal, V6.DirectoryEntry>` even though V6's entry is V5's
// minus two fields.
module {
    public func migrate(old : V5.Mem) : V6.Mem {
        let directory = Map.empty<Principal, V6.DirectoryEntry>();
        for ((canister, entry) in Map.entries(old.directory)) {
            Map.add(
                directory,
                Principal.compare,
                canister,
                {
                    canister = entry.canister;
                    source = entry.source;
                    first_seen_ns = entry.first_seen_ns;
                    last_seen_ns = entry.last_seen_ns;
                    ignored = entry.ignored;
                    retired = entry.retired;
                    strikes = entry.strikes;
                } : V6.DirectoryEntry,
            );
        };

        {
            var revision = old.revision;
            var next_request_seq = old.next_request_seq;
            var next_brush_id = old.next_brush_id;
            var crawl = null;
            designs = old.designs;
            holdings = old.holdings;
            directory;
            incoming = old.incoming;
            outgoing = old.outgoing;
            replay = old.replay;
            brushes = old.brushes;
        };
    };
};
