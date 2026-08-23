import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Designs "./Designs";
import Directory "./Directory";
import Holdings "./Holdings";
import Memory "./memory/chipswap/v9";
import Requirements "./Requirements";
import Shape "./Shape";
import Wire "./Wire";

// The trade state machine. Every transition here is synchronous and total: the
// awaits live in main.mo, so a lost reply is always a state this module can
// name rather than a hole in the middle of a call.
//
// The economics come from Planning/chipswap.md: offering one of our own designs
// mints a fresh instance and costs us nothing, while offering an acquired chip
// consumes it. That is why only the second kind is escrowed.
module {
    public type Result<T> = { #ok : T; #err : Text };

    public let MAX_INCOMING : Nat = 64;
    public let MAX_OUTGOING : Nat = 32;
    public let MAX_REPLAY : Nat = 256;
    public let MAX_HISTORY : Nat = 256;
    public let REQUEST_ID_BYTES : Nat = 16;
    public let MAX_PEER_DESIGN_ID : Nat = 1_000;

    public type OfferSelection = {
        #own : Nat; // one of our published designs; mints a new instance
        #held : Text; // a chip we hold, identified by its holdings key
    };

    public type ProposeArgs = {
        peer : Principal;
        want_design_id : Nat;
        offer : OfferSelection;
    };

    public type Proposal = {
        request_id : Blob;
        offered : Wire.Chip;
        peer : Principal;
        want_design_id : Nat;
    };

    public type InboundTrade = {
        request_id : Blob;
        want_design_id : Nat;
        offered : Wire.Chip;
    };

    public type DeliverOutcome = {
        #minted : Wire.Chip;
        #returned : Wire.Chip;
        #declined;
    };

    public type Delivery = {
        peer : Principal;
        request_id : Blob;
        chip : Wire.Chip;
        outcome : DeliverOutcome;
    };

    // --- Keys and conversions ----------------------------------------------

    public func outgoingKey(requestId : Blob) : Text = hex(requestId);

    public func inboundKey(peer : Principal, requestId : Blob) : Text {
        Principal.toText(peer) # "." # hex(requestId);
    };

    public func chipToWire(chip : Memory.Chip) : Wire.Chip {
        {
            designer = chip.ref.designer;
            design_id = chip.ref.design_id;
            serial = chip.ref.serial;
            title = chip.title;
            art = chip.art;
            nsfw = chip.nsfw;
            design_revision = chip.design_revision;
            minted_at_ns = chip.minted_at_ns;
        };
    };

    public func chipFromWire(chip : Wire.Chip, now : Int) : Memory.Chip {
        {
            ref = {
                designer = chip.designer;
                design_id = chip.design_id;
                serial = chip.serial;
            };
            title = chip.title;
            art = chip.art;
            // The tag is the offering canister's claim about its own art, kept
            // as given. It is the one part of a chip we cannot check, and a
            // requirement that turns on it says so.
            nsfw = chip.nsfw;
            design_revision = chip.design_revision;
            minted_at_ns = chip.minted_at_ns;
            acquired_at_ns = now;
            state = #held;
        };
    };

    // A chip arriving as Candid has only been type-checked by the kernel, so
    // every field is validated here before it can reach memory.
    public func validWireChip(chip : Wire.Chip) : Bool {
        if (not Principal.isCanister(chip.designer)) return false;
        if (chip.design_id == 0 or chip.design_id > MAX_PEER_DESIGN_ID) return false;
        if (chip.serial == 0) return false;
        let titleBytes = Text.encodeUtf8(chip.title).size();
        if (titleBytes == 0 or titleBytes > Wire.MAX_TITLE_BYTES) return false;
        switch (
            Shape.validateArt(chip.art.shape_id, chip.art.palette.size(), chip.art.pixels)
        ) {
            case (?_code) false;
            case null true;
        };
    };

    // --- Proposer side ------------------------------------------------------

    public func newRequestId(mem : Memory.Mem, now : Int) : Blob {
        let sequence = mem.next_request_seq;
        mem.next_request_seq += 1;
        let stamp = if (now <= 0) 0 else Int.abs(now);
        Blob.fromArray(
            Array.tabulate<Nat8>(
                REQUEST_ID_BYTES,
                func(index) {
                    if (index < 8) {
                        byteOf(sequence, 7 - index);
                    } else {
                        byteOf(stamp, 15 - index);
                    };
                },
            )
        );
    };

    public func beginPropose(
        mem : Memory.Mem,
        args : ProposeArgs,
        self : Principal,
        now : Int,
    ) : Result<Proposal> {
        if (Principal.equal(args.peer, self)) return #err("self_trade");
        if (not Principal.isCanister(args.peer)) return #err("invalid_peer");
        // Whether the peer really publishes this design is settled before we
        // get here, by a live query in chipswap_trade_propose. It is not
        // checked twice and it is never assumed: nothing below this line mints
        // or escrows until that query has answered.
        if (Map.size(mem.outgoing) >= MAX_OUTGOING) return #err("outgoing_full");

        let requestId = newRequestId(mem, now);
        let key = outgoingKey(requestId);
        if (Map.get(mem.outgoing, Text.compare, key) != null) return #err("request_reused");

        let (offered, offeredKey) = switch (args.offer) {
            case (#own(designId)) {
                // We gain a chip without losing one, so we need room for it.
                if (Holdings.count(mem) >= Holdings.MAX_HOLDINGS) return #err("holdings_full");
                switch (Designs.mint(mem, designId, self, now)) {
                    case (#err(code)) return #err(code);
                    case (#ok(chip)) (chipToWire(chip), null : ?Text);
                };
            };
            case (#held(chipKey)) {
                switch (Holdings.escrow(mem, chipKey, requestId, args.peer, now)) {
                    case (#err(code)) return #err(code);
                    case (#ok(chip)) (chipToWire(chip), ?chipKey);
                };
            };
        };

        Map.add(
            mem.outgoing,
            Text.compare,
            key,
            {
                request_id = requestId;
                peer = args.peer;
                want_design_id = args.want_design_id;
                offered_key = offeredKey;
                offered_ref = {
                    designer = offered.designer;
                    design_id = offered.design_id;
                    serial = offered.serial;
                };
                offered_title = offered.title;
                state = #sending;
                created_at_ns = now;
                updated_at_ns = now;
            } : Memory.OutgoingTrade,
        );
        ignore Directory.noteExcludingSelf(mem, args.peer, self, #trade, now);
        #ok({
            request_id = requestId;
            offered;
            peer = args.peer;
            want_design_id = args.want_design_id;
        });
    };

    // `null` means the call itself failed or the reply could not be trusted.
    public func finishPropose(
        mem : Memory.Mem,
        requestId : Blob,
        reply : ?Wire.TradeReply,
        self : Principal,
        now : Int,
    ) : Result<Text> {
        let key = outgoingKey(requestId);
        let ?trade = Map.get(mem.outgoing, Text.compare, key) else return #err("unknown_trade");
        if (trade.state != #sending) return #err("not_sending");

        let ?answer = reply else {
            markUncertain(mem, trade, now);
            return #ok("uncertain");
        };

        switch (answer) {
            case (#minted(payload)) {
                completeWithChip(mem, trade, payload.chip, now);
            };
            case (#pending) {
                setOutgoing(mem, key, { trade with state = #pending_designer; updated_at_ns = now });
                #ok("pending");
            };
            case (#declined(payload)) {
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #declined_by_peer(bounded(payload.reason)), now);
                #ok("declined");
            };
            case (#err(payload)) {
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #failed(bounded(payload.code)), now);
                #ok("failed");
            };
        };
    };

    // The designer's later delivery for a manual trade, or a retry of one.
    public func deliverInbound(
        mem : Memory.Mem,
        requestId : Blob,
        caller : Principal,
        outcome : DeliverOutcome,
        now : Int,
    ) : Result<Text> {
        let key = outgoingKey(requestId);
        let ?trade = Map.get(mem.outgoing, Text.compare, key) else {
            // The row is gone because the trade already settled. Saying so is
            // what stops the peer retrying; `unknown_trade` would not.
            if (settledOutgoing(mem, requestId, caller)) return #ok("already_final");
            return #err("unknown_trade");
        };
        if (not Principal.equal(trade.peer, caller)) return #err("unknown_trade");
        switch (trade.state) {
            case (#sending) return #err("not_pending");
            case (#pending_designer) {};
            case (#uncertain) {};
        };
        switch (outcome) {
            case (#minted(chip)) {
                if (not Principal.equal(chip.designer, caller)) return #err("invalid_delivery");
                completeWithChip(mem, trade, chip, now);
            };
            case (#returned(chip)) {
                if (
                    chip.designer != trade.offered_ref.designer or
                    chip.design_id != trade.offered_ref.design_id or
                    chip.serial != trade.offered_ref.serial
                ) return #err("invalid_delivery");
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #declined_by_peer("returned"), now);
                #ok("returned");
            };
            case (#declined) {
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #declined_by_peer("designer_declined"), now);
                #ok("declined");
            };
        };
    };

    // Applying the designer's answer is the only way an uncertain trade ends.
    public func resolveOutgoing(
        mem : Memory.Mem,
        requestId : Blob,
        reply : ?Wire.StatusReply,
        now : Int,
    ) : Result<Text> {
        let key = outgoingKey(requestId);
        let ?trade = Map.get(mem.outgoing, Text.compare, key) else return #err("unknown_trade");
        switch (trade.state) {
            case (#uncertain) {};
            case (#pending_designer) {};
            case (#sending) return #err("not_resolvable");
        };
        let ?answer = reply else return #ok("uncertain");
        switch (answer) {
            case (#unknown) {
                // The designer records an outcome before returning one, so no
                // record means the offer was never admitted and the chip is
                // safe to restore.
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #failed("not_received"), now);
                #ok("not_received");
            };
            case (#pending) {
                setOutgoing(
                    mem,
                    key,
                    { trade with state = #pending_designer; updated_at_ns = now },
                );
                #ok("pending");
            };
            case (#minted(payload)) {
                if (not Principal.equal(payload.chip.designer, trade.peer)) {
                    return #err("invalid_status");
                };
                completeWithChip(mem, trade, payload.chip, now);
            };
            case (#declined(payload)) {
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #declined_by_peer(bounded(payload.reason)), now);
                #ok("declined");
            };
        };
    };

    // --- Designer side ------------------------------------------------------

    public func acceptInbound(
        mem : Memory.Mem,
        request : InboundTrade,
        caller : Principal,
        self : Principal,
        now : Int,
    ) : Wire.TradeReply {
        if (Principal.equal(caller, self)) return #err({ code = "self_trade" });
        if (request.request_id.size() != REQUEST_ID_BYTES) {
            return #err({ code = "invalid_request" });
        };
        if (not validWireChip(request.offered)) return #err({ code = "invalid_offer" });

        let key = inboundKey(caller, request.request_id);
        switch (replayReply(mem, key, caller, request.request_id, self)) {
            case (?reply) return reply;
            case null {};
        };

        // The one place a designer still enters this table without the owner
        // asking. A peer who proposes a trade has proved they are running
        // Chipswap and can be reached, which is exactly what an entry claims, so
        // the same call also withdraws a retirement we had concluded about them.
        ignore Directory.noteExcludingSelf(mem, caller, self, #trade, now);
        if (not Principal.equal(caller, self)) Directory.noteReachable(mem, caller, now);

        let ?design = Designs.get(mem, request.want_design_id) else {
            return #declined({ reason = "unknown_design" });
        };
        if (design.state != #published) {
            return #declined({ reason = "unknown_design" });
        };

        let offeredChip = chipFromWire(request.offered, now);
        let offeredKey = Holdings.key(offeredChip.ref);
        if (Holdings.get(mem, offeredKey) != null) {
            return #declined({ reason = "duplicate_offer" });
        };
        if (offerEscrowed(mem, offeredKey)) {
            return #declined({ reason = "duplicate_offer" });
        };

        // Requirements are settled before anything is held or minted. An offer
        // that does not meet them is refused outright, whether or not the
        // designer also wanted to approve it by hand: approval decides what
        // becomes of an offer that qualifies, not whether it qualifies.
        switch (
            Requirements.checkArt(design.requirements, offeredChip.art, offeredChip.nsfw)
        ) {
            case (?reason) return #declined({ reason });
            case null {};
        };

        if (not design.requirements.approval) {
            if (Holdings.count(mem) >= Holdings.MAX_HOLDINGS) {
                return #declined({ reason = "holdings_full" });
            };
            switch (Holdings.admit(mem, offeredChip)) {
                case (#err(code)) return #declined({ reason = code });
                case (#ok(())) {};
            };
            switch (Designs.mint(mem, request.want_design_id, self, now)) {
                case (#err(code)) return #declined({ reason = code });
                case (#ok(minted)) {
                    recordReplay(
                        mem,
                        key,
                        caller,
                        request.request_id,
                        #minted({
                            design_id = request.want_design_id;
                            serial = minted.ref.serial;
                            nsfw = minted.nsfw;
                        }),
                        now,
                    );
                    return #minted({ chip = chipToWire(minted) });
                };
            };
        };

        if (Map.size(mem.incoming) >= MAX_INCOMING) {
            return #declined({ reason = "incoming_full" });
        };
        Map.add(
            mem.incoming,
            Text.compare,
            key,
            {
                request_id = request.request_id;
                peer = caller;
                want_design_id = request.want_design_id;
                offered = offeredChip;
                state = #pending;
                received_at_ns = now;
                updated_at_ns = now;
            } : Memory.IncomingTrade,
        );
        recordReplay(mem, key, caller, request.request_id, #pending, now);
        #pending;
    };

    public func acceptPending(
        mem : Memory.Mem,
        requestId : Blob,
        self : Principal,
        now : Int,
    ) : Result<Delivery> {
        let ?(key, trade) = findIncoming(mem, requestId) else return #err("unknown_trade");
        if (trade.state != #pending) return #err("not_pending");
        if (Holdings.count(mem) >= Holdings.MAX_HOLDINGS) return #err("holdings_full");
        let minted = switch (Designs.mint(mem, trade.want_design_id, self, now)) {
            case (#err(code)) return #err(code);
            case (#ok(chip)) chip;
        };
        switch (Holdings.admit(mem, trade.offered)) {
            case (#err(code)) return #err(code);
            case (#ok(())) {};
        };
        Map.add(
            mem.incoming,
            Text.compare,
            key,
            {
                trade with
                state = #accepted({ serial = minted.ref.serial; nsfw = minted.nsfw });
                updated_at_ns = now;
            } : Memory.IncomingTrade,
        );
        recordReplay(
            mem,
            key,
            trade.peer,
            requestId,
            #minted({
                design_id = trade.want_design_id;
                serial = minted.ref.serial;
                nsfw = minted.nsfw;
            }),
            now,
        );
        #ok({
            peer = trade.peer;
            request_id = requestId;
            chip = chipToWire(minted);
            outcome = #minted(chipToWire(minted));
        });
    };

    public func declinePending(
        mem : Memory.Mem,
        requestId : Blob,
        now : Int,
    ) : Result<Delivery> {
        let ?(key, trade) = findIncoming(mem, requestId) else return #err("unknown_trade");
        if (trade.state != #pending) return #err("not_pending");
        Map.add(
            mem.incoming,
            Text.compare,
            key,
            { trade with state = #declined; updated_at_ns = now } : Memory.IncomingTrade,
        );
        recordReplay(mem, key, trade.peer, requestId, #declined("designer_declined"), now);
        let original = chipToWire(trade.offered);
        #ok({
            peer = trade.peer;
            request_id = requestId;
            chip = original;
            outcome = #returned(original);
        });
    };

    // Rebuilds the exact delivery a failed send should repeat. The serial and
    // mint time come from the stored record, so a retry is byte-identical.
    public func retryDelivery(
        mem : Memory.Mem,
        requestId : Blob,
        self : Principal,
    ) : Result<Delivery> {
        let ?(_key, trade) = findIncoming(mem, requestId) else return #err("unknown_trade");
        switch (trade.state) {
            case (#accepted(details)) {
                let ?design = Designs.get(mem, trade.want_design_id) else return #err("not_found");
                let chip = mintedView(
                    design,
                    details.serial,
                    trade.updated_at_ns,
                    self,
                    details.nsfw,
                );
                #ok({
                    peer = trade.peer;
                    request_id = requestId;
                    chip;
                    outcome = #minted(chip);
                });
            };
            case (#declined) {
                let original = chipToWire(trade.offered);
                #ok({
                    peer = trade.peer;
                    request_id = requestId;
                    chip = original;
                    outcome = #returned(original);
                });
            };
            case (#pending) #err("not_delivered");
        };
    };

    // The single point a settled inbound row is dropped, and therefore the
    // single point its record is written.
    public func completeDelivery(
        mem : Memory.Mem,
        requestId : Blob,
        self : Principal,
        now : Int,
    ) : Result<()> {
        let ?(key, trade) = findIncoming(mem, requestId) else return #err("unknown_trade");
        if (trade.state == #pending) return #err("not_delivered");

        let theirs : ?Memory.HistoryChip = ?{
            title = trade.offered.title;
            ref = trade.offered.ref;
        };
        let (ours, outcome) : (?Memory.HistoryChip, Memory.HistoryOutcome) = switch (trade.state) {
            case (#accepted(details)) {
                let title = switch (Designs.get(mem, trade.want_design_id)) {
                    case (?design) design.title;
                    case null "";
                };
                (
                    ?{
                        title;
                        ref = {
                            designer = self;
                            design_id = trade.want_design_id;
                            serial = details.serial;
                        };
                    },
                    #traded,
                );
            };
            // We never minted, and their chip went back to them. The row still
            // names that chip, because that is the whole content of it.
            case (_) (null, #declined_by_owner);
        };
        ignore recordHistory(
            mem,
            #incoming,
            trade.peer,
            trade.request_id,
            trade.want_design_id,
            ours,
            theirs,
            null,
            outcome,
            trade.received_at_ns,
            now,
        );
        Map.remove(mem.incoming, Text.compare, key);
        #ok(());
    };

    // Answers a proposer asking what became of their request. The live incoming
    // record is consulted first so a trade we are still holding can never be
    // reported as unknown.
    public func statusOf(
        mem : Memory.Mem,
        requestId : Blob,
        caller : Principal,
        self : Principal,
    ) : Wire.StatusReply {
        let key = inboundKey(caller, requestId);
        switch (Map.get(mem.incoming, Text.compare, key)) {
            case (?trade) {
                switch (trade.state) {
                    case (#pending) return #pending;
                    case (#accepted(details)) {
                        let ?design = Designs.get(mem, trade.want_design_id) else return #unknown;
                        return #minted({
                            chip = mintedView(
                                design,
                                details.serial,
                                trade.updated_at_ns,
                                self,
                                details.nsfw,
                            )
                        });
                    };
                    case (#declined) return #declined({ reason = "designer_declined" });
                };
            };
            case null {};
        };
        switch (Map.get(mem.replay, Text.compare, key)) {
            case (?record) {
                if (not Principal.equal(record.peer, caller)) return #unknown;
                switch (record.outcome) {
                    case (#pending) #pending;
                    case (#declined(reason)) #declined({ reason });
                    case (#minted(details)) {
                        let ?design = Designs.get(mem, details.design_id) else return #unknown;
                        #minted({
                            chip = mintedView(
                                design,
                                details.serial,
                                record.recorded_at_ns,
                                self,
                                details.nsfw,
                            )
                        });
                    };
                };
            };
            case null #unknown;
        };
    };

    // --- Listings -----------------------------------------------------------

    public func pendingIncoming(mem : Memory.Mem) : [Memory.IncomingTrade] {
        Array.sort<Memory.IncomingTrade>(
            Array.map<(Text, Memory.IncomingTrade), Memory.IncomingTrade>(
                Map.toArray(mem.incoming),
                func(entry) { entry.1 },
            ),
            func(left, right) {
                switch (Int.compare(right.received_at_ns, left.received_at_ns)) {
                    case (#equal) Text.compare(hex(left.request_id), hex(right.request_id));
                    case (order) order;
                };
            },
        );
    };

    public func pendingOutgoing(mem : Memory.Mem) : [Memory.OutgoingTrade] {
        Array.sort<Memory.OutgoingTrade>(
            Array.map<(Text, Memory.OutgoingTrade), Memory.OutgoingTrade>(
                Map.toArray(mem.outgoing),
                func(entry) { entry.1 },
            ),
            func(left, right) {
                switch (Int.compare(right.created_at_ns, left.created_at_ns)) {
                    case (#equal) Text.compare(hex(left.request_id), hex(right.request_id));
                    case (order) order;
                };
            },
        );
    };

    // --- The record of what happened ----------------------------------------

    // Recording a trade can never fail. When the table is full the oldest entry
    // goes, because the alternative — refusing the new one — throws away the
    // record the owner is most likely to be looking for.
    public func recordHistory(
        mem : Memory.Mem,
        direction : Memory.HistoryDirection,
        peer : Principal,
        requestId : Blob,
        wantDesignId : Nat,
        ours : ?Memory.HistoryChip,
        theirs : ?Memory.HistoryChip,
        escrowKey : ?Text,
        outcome : Memory.HistoryOutcome,
        startedAt : Int,
        now : Int,
    ) : Nat {
        if (Map.size(mem.history) >= MAX_HISTORY) evictOldest(mem);
        let entryId = mem.next_history_id;
        mem.next_history_id += 1;
        Map.add(
            mem.history,
            Nat.compare,
            entryId,
            {
                entry_id = entryId;
                direction;
                peer;
                request_id = requestId;
                want_design_id = wantDesignId;
                ours;
                theirs;
                escrow_key = escrowKey;
                outcome;
                started_at_ns = startedAt;
                settled_at_ns = now;
            } : Memory.HistoryEntry,
        );
        entryId;
    };

    // Newest first. Ids ascend with time, so they are the whole sort key; the
    // sort is written out rather than leaning on the map's iteration order,
    // which is how `Holdings.page` does it too.
    public func historyPage(
        mem : Memory.Mem,
        offset : Nat,
        limit : Nat,
    ) : { entries : [Memory.HistoryEntry]; total : Nat } {
        let all = Array.sort<(Nat, Memory.HistoryEntry)>(
            Map.toArray(mem.history),
            func(left, right) { Nat.compare(right.0, left.0) },
        );
        let total = all.size();
        if (offset >= total or limit == 0) return { entries = []; total };
        let available : Nat = total - offset;
        let take = if (limit < available) limit else available;
        {
            entries = Array.tabulate<Memory.HistoryEntry>(take, func(i) { all[offset + i].1 });
            total;
        };
    };

    public func forgetHistory(mem : Memory.Mem, entryId : Nat) : Result<()> {
        let ?_entry = Map.get(mem.history, Nat.compare, entryId) else {
            return #err("unknown_entry");
        };
        Map.remove(mem.history, Nat.compare, entryId);
        #ok(());
    };

    // An unresolved entry is the last thing naming a chip that is still
    // `#uncertain` in holdings, so a bulk clear leaves it alone. Forgetting one
    // by hand stays allowed: the owner may genuinely want it gone.
    public func clearHistory(mem : Memory.Mem) : Nat {
        var removed = 0;
        for ((entryId, entry) in Map.toArray(mem.history).values()) {
            if (entry.outcome != #unresolved) {
                Map.remove(mem.history, Nat.compare, entryId);
                removed += 1;
            };
        };
        removed;
    };

    public func findUnresolved(mem : Memory.Mem, requestId : Blob) : ?Memory.HistoryEntry {
        let target = hex(requestId);
        for ((_, entry) in Map.entries(mem.history)) {
            if (
                entry.direction == #outgoing and
                entry.outcome == #unresolved and
                hex(entry.request_id) == target
            ) return ?entry;
        };
        null;
    };

    // Whether a settled record already answers for this request. A peer
    // retrying a delivery we have already dealt with has to be told the trade
    // finished, or it retries forever.
    public func settledOutgoing(
        mem : Memory.Mem,
        requestId : Blob,
        peer : Principal,
    ) : Bool {
        let target = hex(requestId);
        for ((_, entry) in Map.entries(mem.history)) {
            if (
                entry.direction == #outgoing and
                Principal.equal(entry.peer, peer) and
                hex(entry.request_id) == target
            ) return true;
        };
        false;
    };

    // Setting aside a trade whose outcome was never confirmed. It frees the
    // slot and records what is known, which is nothing new — so the chip is not
    // touched. Releasing it here would duplicate a unique chip into the world
    // every time the guess was wrong, with no way to notice afterwards.
    public func abandonOutgoing(mem : Memory.Mem, requestId : Blob, now : Int) : Result<()> {
        let key = outgoingKey(requestId);
        let ?trade = Map.get(mem.outgoing, Text.compare, key) else return #err("unknown_trade");
        if (trade.state != #uncertain) return #err("not_uncertain");
        settleOutgoing(mem, key, trade, null, #unresolved, now);
        #ok(());
    };

    // Asking again about a trade the owner had set aside. The entry is rewritten
    // in place rather than added to, so one trade stays one row.
    public func resolveUnresolved(
        mem : Memory.Mem,
        requestId : Blob,
        reply : ?Wire.StatusReply,
        now : Int,
    ) : Result<Text> {
        let ?entry = findUnresolved(mem, requestId) else return #err("unknown_trade");
        let ?answer = reply else return #ok("uncertain");
        switch (answer) {
            case (#pending) #ok("pending");
            case (#unknown) {
                // The designer records an outcome before returning one, so no
                // record means the offer was never admitted and the chip is
                // safe to restore.
                releaseEscrow(mem, entry);
                rewriteHistory(mem, entry, null, #failed("not_received"), now);
                #ok("not_received");
            };
            case (#declined(payload)) {
                releaseEscrow(mem, entry);
                rewriteHistory(mem, entry, null, #declined_by_peer(bounded(payload.reason)), now);
                #ok("declined");
            };
            case (#minted(payload)) {
                let chip = payload.chip;
                if (not Principal.equal(chip.designer, entry.peer)) return #err("invalid_status");
                if (not validWireChip(chip)) return #err("invalid_reply");
                if (chip.design_id != entry.want_design_id) return #err("invalid_reply");
                switch (entry.escrow_key) {
                    case (?chipKey) ignore Holdings.consume(mem, chipKey);
                    case null {};
                };
                let received = chipFromWire(chip, now);
                let theirs : ?Memory.HistoryChip = ?{
                    title = received.title;
                    ref = received.ref;
                };
                switch (Holdings.admit(mem, received)) {
                    case (#err(code)) {
                        rewriteHistory(mem, entry, theirs, #failed(code), now);
                        return #err(code);
                    };
                    case (#ok(())) {};
                };
                rewriteHistory(mem, entry, theirs, #traded, now);
                #ok("completed");
            };
        };
    };

    func releaseEscrow(mem : Memory.Mem, entry : Memory.HistoryEntry) {
        switch (entry.escrow_key) {
            case (?chipKey) ignore Holdings.release(mem, chipKey);
            case null {};
        };
    };

    func rewriteHistory(
        mem : Memory.Mem,
        entry : Memory.HistoryEntry,
        theirs : ?Memory.HistoryChip,
        outcome : Memory.HistoryOutcome,
        now : Int,
    ) {
        Map.add(
            mem.history,
            Nat.compare,
            entry.entry_id,
            { entry with theirs; outcome; settled_at_ns = now },
        );
    };

    func evictOldest(mem : Memory.Mem) {
        var victim : ?Nat = null;
        for ((entryId, _) in Map.entries(mem.history)) {
            switch (victim) {
                case (?current) if (entryId < current) victim := ?entryId;
                case null victim := ?entryId;
            };
        };
        switch (victim) {
            case (?entryId) Map.remove(mem.history, Nat.compare, entryId);
            case null {};
        };
    };

    // The one way a terminal outgoing trade is stored: the row leaves the live
    // table and the record appears, as a single act. Every transition that ends
    // a trade goes through here, which is what keeps the two in step.
    func settleOutgoing(
        mem : Memory.Mem,
        key : Text,
        trade : Memory.OutgoingTrade,
        theirs : ?Memory.HistoryChip,
        outcome : Memory.HistoryOutcome,
        now : Int,
    ) {
        Map.remove(mem.outgoing, Text.compare, key);
        ignore recordHistory(
            mem,
            #outgoing,
            trade.peer,
            trade.request_id,
            trade.want_design_id,
            ?{ title = trade.offered_title; ref = trade.offered_ref },
            theirs,
            trade.offered_key,
            outcome,
            trade.created_at_ns,
            now,
        );
    };

    public func getOutgoing(mem : Memory.Mem, requestId : Blob) : ?Memory.OutgoingTrade {
        Map.get(mem.outgoing, Text.compare, outgoingKey(requestId));
    };

    // --- Internals ----------------------------------------------------------

    func setOutgoing(mem : Memory.Mem, key : Text, trade : Memory.OutgoingTrade) {
        Map.add(mem.outgoing, Text.compare, key, trade);
    };

    func markUncertain(mem : Memory.Mem, trade : Memory.OutgoingTrade, now : Int) {
        switch (trade.offered_key) {
            case (?chipKey) ignore Holdings.markUncertain(mem, chipKey);
            case null {};
        };
        setOutgoing(
            mem,
            outgoingKey(trade.request_id),
            { trade with state = #uncertain; updated_at_ns = now },
        );
    };

    // Restores an escrowed offer. An own-design offer has nothing to restore:
    // the minted instance never left our design's serial counter.
    func restoreOffer(mem : Memory.Mem, trade : Memory.OutgoingTrade) {
        switch (trade.offered_key) {
            case (?chipKey) ignore Holdings.release(mem, chipKey);
            case null {};
        };
    };

    func completeWithChip(
        mem : Memory.Mem,
        trade : Memory.OutgoingTrade,
        chip : Wire.Chip,
        now : Int,
    ) : Result<Text> {
        let key = outgoingKey(trade.request_id);
        if (not validWireChip(chip)) {
            markUncertain(mem, trade, now);
            return #err("invalid_reply");
        };
        if (chip.design_id != trade.want_design_id) {
            markUncertain(mem, trade, now);
            return #err("invalid_reply");
        };
        // The offer is gone the moment the peer says it accepted it.
        switch (trade.offered_key) {
            case (?chipKey) ignore Holdings.consume(mem, chipKey);
            case null {};
        };
        let received = chipFromWire(chip, now);
        // Their side is known here either way, so the record names it even when
        // the chip could not be admitted.
        let theirs : ?Memory.HistoryChip = ?{ title = received.title; ref = received.ref };
        switch (Holdings.admit(mem, received)) {
            case (#err(code)) {
                settleOutgoing(mem, key, trade, theirs, #failed(code), now);
                return #err(code);
            };
            case (#ok(())) {};
        };
        settleOutgoing(mem, key, trade, theirs, #traded, now);
        #ok("completed");
    };

    // The chip as it was minted, rebuilt from what was recorded. The tag comes
    // from the record rather than from the design, because the design's tag may
    // have moved since and this chip did not.
    func mintedView(
        design : Memory.Design,
        serial : Nat,
        mintedAt : Int,
        self : Principal,
        nsfw : Bool,
    ) : Wire.Chip {
        {
            designer = self;
            design_id = design.design_id;
            serial;
            title = design.title;
            art = design.art;
            nsfw;
            design_revision = design.revision;
            minted_at_ns = mintedAt;
        };
    };

    func findIncoming(
        mem : Memory.Mem,
        requestId : Blob,
    ) : ?(Text, Memory.IncomingTrade) {
        let target = hex(requestId);
        for ((key, trade) in Map.entries(mem.incoming)) {
            if (hex(trade.request_id) == target) return ?(key, trade);
        };
        null;
    };

    // A chip already held in manual escrow cannot be offered to us again.
    func offerEscrowed(mem : Memory.Mem, offeredKey : Text) : Bool {
        for ((_key, trade) in Map.entries(mem.incoming)) {
            if (trade.state == #pending and Holdings.key(trade.offered.ref) == offeredKey) {
                return true;
            };
        };
        false;
    };

    func replayReply(
        mem : Memory.Mem,
        key : Text,
        caller : Principal,
        requestId : Blob,
        self : Principal,
    ) : ?Wire.TradeReply {
        let ?record = Map.get(mem.replay, Text.compare, key) else return null;
        if (not Principal.equal(record.peer, caller)) return null;
        if (hex(record.request_id) != hex(requestId)) return null;
        switch (record.outcome) {
            case (#pending) ?#pending;
            case (#declined(reason)) ?#declined({ reason });
            case (#minted(details)) {
                let ?design = Designs.get(mem, details.design_id) else return null;
                ?#minted({
                    chip = mintedView(
                        design,
                        details.serial,
                        record.recorded_at_ns,
                        self,
                        details.nsfw,
                    );
                });
            };
        };
    };

    func recordReplay(
        mem : Memory.Mem,
        key : Text,
        peer : Principal,
        requestId : Blob,
        outcome : Memory.ReplayOutcome,
        now : Int,
    ) {
        if (
            Map.get(mem.replay, Text.compare, key) == null and
            Map.size(mem.replay) >= MAX_REPLAY
        ) evictReplay(mem);
        Map.add(
            mem.replay,
            Text.compare,
            key,
            {
                request_id = requestId;
                peer;
                outcome;
                recorded_at_ns = now;
            } : Memory.ReplayRecord,
        );
    };

    // Only records with no live incoming trade may be forgotten: a trade we are
    // still holding must never be reported as unknown to its proposer.
    func evictReplay(mem : Memory.Mem) {
        var victim : ?(Text, Int) = null;
        for ((key, record) in Map.entries(mem.replay)) {
            if (Map.get(mem.incoming, Text.compare, key) == null) {
                switch (victim) {
                    case (?(_, recorded)) {
                        if (record.recorded_at_ns < recorded) {
                            victim := ?(key, record.recorded_at_ns);
                        };
                    };
                    case null victim := ?(key, record.recorded_at_ns);
                };
            };
        };
        switch (victim) {
            case (?(key, _)) Map.remove(mem.replay, Text.compare, key);
            case null {};
        };
    };

    func bounded(value : Text) : Text {
        if (Text.encodeUtf8(value).size() <= Wire.MAX_CODE_BYTES) return value;
        "unspecified";
    };

    func byteOf(value : Nat, position : Nat) : Nat8 {
        var shifted = value;
        var index = 0;
        while (index < position) {
            shifted /= 256;
            index += 1;
        };
        Nat8.fromNat(shifted % 256);
    };

    let HEX_DIGITS : [Text] = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f",
    ];

    public func hex(value : Blob) : Text {
        var result = "";
        for (byte in value.values()) {
            let natural = Nat8.toNat(byte);
            result #= HEX_DIGITS[natural / 16] # HEX_DIGITS[natural % 16];
        };
        result;
    };

    public func unhex(value : Text) : ?Blob {
        let characters = Text.toArray(value);
        if (characters.size() % 2 != 0) return null;
        let bytes = List.empty<Nat8>();
        var index = 0;
        while (index < characters.size()) {
            let ?high = hexValue(characters[index]) else return null;
            let ?low = hexValue(characters[index + 1]) else return null;
            List.add(bytes, Nat8.fromNat(high * 16 + low));
            index += 2;
        };
        ?Blob.fromArray(List.toArray(bytes));
    };

    func hexValue(character : Char) : ?Nat {
        switch (character) {
            case ('0') ?0;
            case ('1') ?1;
            case ('2') ?2;
            case ('3') ?3;
            case ('4') ?4;
            case ('5') ?5;
            case ('6') ?6;
            case ('7') ?7;
            case ('8') ?8;
            case ('9') ?9;
            case ('a') ?10;
            case ('b') ?11;
            case ('c') ?12;
            case ('d') ?13;
            case ('e') ?14;
            case ('f') ?15;
            case (_) null;
        };
    };

    public func natText(value : Nat) : Text = Nat.toText(value);
}
