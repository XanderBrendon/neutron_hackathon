import Map "mo:core/Map";
import Principal "mo:core/Principal";
import V7 "./v7";
import V8 "./v8";

// Retirement is dropped rather than translated.
//
// A retired designer becomes an ordinary entry: asked again on the next
// catalog read, and named to the owner if they really are gone. That is the
// whole change, and translating the flag into an ignore instead would have
// been the wrong repair. `ignored` is the owner's standing instruction and
// `retired` never was — most of them were reached by a strike counter the
// owner never saw, and an upgrade that quietly relabelled a machine's guess as
// the owner's decision would leave them a silence they have to discover before
// they can undo it.
//
// Coming back into rotation costs one query per designer, on the machine that
// asked, at the moment the Market next opens. A canister that is genuinely gone
// pays for it once and then appears by name with Ignore and Remove beside it,
// which is the outcome the flag was reaching for and never quite had.
//
// `ignored` carries across untouched, and so does everything else. The rebuild
// below is a retyping, not a rewrite: `Map` is invariant in its value type, so
// a `Map.Map<Principal, V7.DirectoryEntry>` cannot stand in for a
// `Map.Map<Principal, V8.DirectoryEntry>` even though V8's entry is V7's minus
// two fields.
module {
    public func migrate(old : V7.Mem) : V8.Mem {
        let directory = Map.empty<Principal, V8.DirectoryEntry>();
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
                } : V8.DirectoryEntry,
            );
        };

        {
            var revision = old.revision;
            var next_request_seq = old.next_request_seq;
            var next_brush_id = old.next_brush_id;
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
