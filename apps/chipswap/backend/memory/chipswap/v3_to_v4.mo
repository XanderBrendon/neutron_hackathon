import Map "mo:core/Map";
import Principal "mo:core/Principal";
import V3 "./v3";
import V4 "./v4";

// Every V4 type except the directory entry describes exactly the same record as
// its V3 counterpart, so designs, holdings, catalogs, trades, replay records and
// brushes carry over as themselves. Only the directory is rebuilt.
//
// Two source variants no longer exist, and both have an honest successor rather
// than a placeholder. `#exchange` already meant "read out of a peer's
// directory", which is what a crawl does, so it becomes `#crawl`. `#announce`
// meant "they called us to say they were there", and the only call that says
// that now is a trade proposal, so it becomes `#trade`. Neither rewrite invents
// history: both keep the answer to "did the owner choose this designer?", which
// is the question the source field is read for.
//
// `announced` is dropped with the route that set it. Nobody has been retired or
// has struck out before this version, so every entry arrives clear, and no
// crawl is in progress on an upgrade.
module {
    public func migrate(old : V3.Mem) : V4.Mem {
        let directory = Map.empty<Principal, V4.DirectoryEntry>();
        for ((canister, entry) in Map.entries(old.directory)) {
            Map.add(directory, Principal.compare, canister, convertEntry(entry));
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

    func convertEntry(entry : V3.DirectoryEntry) : V4.DirectoryEntry {
        {
            canister = entry.canister;
            source = switch (entry.source) {
                case (#manual) #manual;
                case (#contacts) #contacts;
                case (#trade) #trade;
                case (#announce) #trade;
                case (#exchange) #crawl;
            };
            first_seen_ns = entry.first_seen_ns;
            last_seen_ns = entry.last_seen_ns;
            ignored = entry.ignored;
            retired = false;
            strikes = 0;
            last_catalog_ns = entry.last_catalog_ns;
            design_count = entry.design_count;
        };
    };
};
