import Array "mo:core/Array";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import V8 "./v8";
import V9 "./v9";

// A settled trade moves out of `outgoing` and into `history`.
//
// This migration is not a reset, because the data is right there. Every
// terminal outgoing row holds a trade that really happened, with the peer, the
// chip offered and the time it settled, and dropping them to start the ledger
// empty would throw away the only record of them that exists.
//
// The inbound side does start empty, and that is not the same choice. Those
// rows were deleted at delivery under V8 and there is nothing left to read.
// Writing plausible-looking entries instead would put trades in the owner's
// ledger that this canister cannot show ever took place.
module {
    // `Holdings.key` in the app, repeated here rather than imported: a
    // migration must keep working the way it did the day it was released, and
    // an app module is free to change.
    func holdingsKey(ref : V9.ChipRef) : Text {
        Principal.toText(ref.designer) # "." # Nat.toText(ref.design_id) # "."
        # Nat.toText(ref.serial);
    };

    func chipOf(title : Text, ref : V9.ChipRef) : V9.HistoryChip = { title; ref };

    public func migrate(old : V8.Mem) : V9.Mem {
        let outgoing = Map.empty<Text, V9.OutgoingTrade>();
        let settled = List.empty<V8.OutgoingTrade>();

        for ((key, trade) in Map.entries(old.outgoing)) {
            let live : ?V9.OutgoingState = switch (trade.state) {
                case (#sending) ?#sending;
                case (#pending_designer) ?#pending_designer;
                case (#uncertain) ?#uncertain;
                case (_) null;
            };
            switch (live) {
                case (?state) {
                    Map.add(
                        outgoing,
                        Text.compare,
                        key,
                        {
                            request_id = trade.request_id;
                            peer = trade.peer;
                            want_design_id = trade.want_design_id;
                            offered_key = trade.offered_key;
                            offered_ref = trade.offered_ref;
                            offered_title = trade.offered_title;
                            state;
                            created_at_ns = trade.created_at_ns;
                            updated_at_ns = trade.updated_at_ns;
                        } : V9.OutgoingTrade,
                    );
                };
                case null List.add(settled, trade);
            };
        };

        // Oldest first, so the ids the entries get run the same way time does.
        // The offered chip breaks ties, because two trades settled in the same
        // nanosecond still need a stable order across a re-run.
        let ordered = Array.sort<V8.OutgoingTrade>(
            List.toArray(settled),
            func(left, right) {
                switch (Int.compare(left.created_at_ns, right.created_at_ns)) {
                    case (#equal) Text.compare(
                        holdingsKey(left.offered_ref),
                        holdingsKey(right.offered_ref),
                    );
                    case (order) order;
                };
            },
        );

        let history = Map.empty<Nat, V9.HistoryEntry>();
        var nextId = 1;
        for (trade in ordered.values()) {
            // A chip we received has a ref but no title on the old row. Where we
            // still hold it the title is exact; where we no longer do, the row
            // keeps the ref and says nothing it cannot support.
            let (theirs, outcome) : (?V9.HistoryChip, V9.HistoryOutcome) = switch (trade.state) {
                case (#completed(ref)) {
                    let title = switch (Map.get(old.holdings, Text.compare, holdingsKey(ref))) {
                        case (?chip) chip.title;
                        case null "";
                    };
                    (?chipOf(title, ref), #traded);
                };
                case (#declined(reason)) (null, #declined_by_peer(reason));
                case (#failed(code)) (null, #failed(code));
                // Unreachable: the three live states were filtered out above.
                case (_) (null, #unresolved);
            };
            Map.add(
                history,
                Nat.compare,
                nextId,
                {
                    entry_id = nextId;
                    direction = #outgoing;
                    peer = trade.peer;
                    request_id = trade.request_id;
                    want_design_id = trade.want_design_id;
                    ours = ?chipOf(trade.offered_title, trade.offered_ref);
                    theirs;
                    escrow_key = trade.offered_key;
                    outcome;
                    started_at_ns = trade.created_at_ns;
                    settled_at_ns = trade.updated_at_ns;
                } : V9.HistoryEntry,
            );
            nextId += 1;
        };

        {
            var revision = old.revision;
            var next_request_seq = old.next_request_seq;
            var next_brush_id = old.next_brush_id;
            var next_history_id = nextId;
            designs = old.designs;
            holdings = old.holdings;
            directory = old.directory;
            incoming = old.incoming;
            outgoing;
            replay = old.replay;
            history;
            brushes = old.brushes;
        };
    };
};
