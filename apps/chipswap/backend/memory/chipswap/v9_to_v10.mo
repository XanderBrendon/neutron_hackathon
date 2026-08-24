import Map "mo:core/Map";
import Principal "mo:core/Principal";
import V9 "./v9";
import V10 "./v10";

// A directory entry gains the list of that designer's chips the owner has
// turned away.
//
// Nobody has turned one away before this release, so an empty list is the truth
// about every existing entry rather than a default standing in for data that
// was lost. That is the whole conversion: one new field on one type, filled
// with the only value it can honestly hold.
//
// Everything else is handed over by reference. A migration that rebuilt roots
// it does not change could only lose something, and the entries themselves are
// rewritten only because Motoko records are immutable — every other field on
// them arrives exactly as it left.
module {
    public func migrate(old : V9.Mem) : V10.Mem {
        let directory = Map.empty<Principal, V10.DirectoryEntry>();
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
                    ignored_designs = [];
                } : V10.DirectoryEntry,
            );
        };

        {
            var revision = old.revision;
            var next_request_seq = old.next_request_seq;
            var next_brush_id = old.next_brush_id;
            var next_history_id = old.next_history_id;
            designs = old.designs;
            holdings = old.holdings;
            directory;
            incoming = old.incoming;
            outgoing = old.outgoing;
            replay = old.replay;
            history = old.history;
            brushes = old.brushes;
        };
    };
};
