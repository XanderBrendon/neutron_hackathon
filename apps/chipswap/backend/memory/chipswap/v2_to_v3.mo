import Map "mo:core/Map";
import Principal "mo:core/Principal";
import V2 "./v2";
import V3 "./v3";

// Every V3 type except the directory entry describes exactly the same record as
// its V2 counterpart, so the designs, holdings, catalogs, trades, replay records
// and brushes carry over as themselves. Only the directory is rebuilt.
//
// Nobody could have been ignored before this version, so every entry arrives
// un-ignored. That is also the answer for the auto-announce setting V2 kept: it
// is dropped rather than converted, because announcing is once again something
// the owner does one peer at a time. An owner who had it switched on loses no
// announcement already made — `announced` is per entry and survives untouched.
module {
    public func migrate(old : V2.Mem) : V3.Mem {
        let directory = Map.empty<Principal, V3.DirectoryEntry>();
        for ((canister, entry) in Map.entries(old.directory)) {
            Map.add(directory, Principal.compare, canister, convertEntry(entry));
        };

        {
            var revision = old.revision;
            var next_request_seq = old.next_request_seq;
            var next_brush_id = old.next_brush_id;
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

    func convertEntry(entry : V2.DirectoryEntry) : V3.DirectoryEntry {
        {
            canister = entry.canister;
            source = switch (entry.source) {
                case (#manual) #manual;
                case (#contacts) #contacts;
                case (#trade) #trade;
                case (#announce) #announce;
                case (#exchange) #exchange;
            };
            first_seen_ns = entry.first_seen_ns;
            last_seen_ns = entry.last_seen_ns;
            announced = entry.announced;
            ignored = false;
            last_catalog_ns = entry.last_catalog_ns;
            design_count = entry.design_count;
        };
    };
};
