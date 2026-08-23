import V6 "./v6";
import V7 "./v7";

// The crawl is dropped. Everything else carries across untouched.
//
// Unlike V5 -> V6 this rebuilds nothing: `DirectoryEntry` is identical between
// the two versions, so every map is the same type on both sides and moves by
// reference. A migration that retyped them anyway would be copying five
// hundred entries to prove a point.
//
// An install upgrading part-way through a crawl loses that crawl, and that is
// the correct outcome rather than an accepted cost. The designers it had
// already found were written into `directory` as it went, so nothing
// discovered is lost; what goes is a position in a walk that this canister no
// longer knows how to continue. The browser starts a new one when the owner
// asks for it.
module {
    public func migrate(old : V6.Mem) : V7.Mem {
        {
            var revision = old.revision;
            var next_request_seq = old.next_request_seq;
            var next_brush_id = old.next_brush_id;
            designs = old.designs;
            holdings = old.holdings;
            directory = old.directory;
            incoming = old.incoming;
            outgoing = old.outgoing;
            replay = old.replay;
            brushes = old.brushes;
        };
    };
};
