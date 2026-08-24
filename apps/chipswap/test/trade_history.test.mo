import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Designs "../backend/Designs";
import Memory "../backend/memory/chipswap/v10";
import Shape "../backend/Shape";
import Trades "../backend/Trades";
import Wire "../backend/Wire";

// What a finished trade leaves behind. The live tables hold work in progress;
// everything that settled is here, in both directions, including the offers
// that were turned down.

func principalOf(seed : Nat) : Principal {
    Principal.fromBlob(Blob.fromArray([Nat8.fromNat(seed), 0, 0, 0, 0, 0, 0, 0, 1, 1]));
};

let alice = principalOf(1); // us
let bob = principalOf(2); // the peer

let art : Wire.Art = {
    shape_id = Shape.SHAPE_ID;
    palette = [0x101010, 0xffffff];
    pixels = Blob.fromArray(
        Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(i) { Nat8.fromNat(i % 2) })
    );
};

func requestId(seed : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(16, func(i) { Nat8.fromNat((seed + i) % 256) }));
};

func peerChip(serial : Nat) : Wire.Chip {
    {
        designer = bob;
        design_id = 1;
        serial;
        title = "Peer chip";
        art;
        nsfw = false;
        design_revision = 1;
        minted_at_ns = 50;
    };
};

func expectOk<T>(result : Trades.Result<T>) : T {
    switch (result) {
        case (#ok(value)) value;
        case (#err(code)) Runtime.trap("unexpected error: " # code);
    };
};

let OPEN = Memory.openRequirements();
let APPROVES = { OPEN with approval = true };

// A canister with one published design to offer.
func memoryWith(requirements : Memory.TradeRequirements) : Memory.Mem {
    let mem = Memory.init();
    switch (Designs.create(mem, "Ours", 10)) {
        case (#ok(_)) {};
        case (#err(code)) Runtime.trap(code);
    };
    switch (Designs.publish(mem, 1, 1, requirements, false, 20)) {
        case (#ok(())) {};
        case (#err(code)) Runtime.trap(code);
    };
    mem;
};

func onlyEntry(mem : Memory.Mem) : Memory.HistoryEntry {
    let page = Trades.historyPage(mem, 0, 100);
    if (page.total != 1) Runtime.trap("expected exactly one history entry");
    page.entries[0];
};

// --- A completed outgoing trade records both sides ------------------------

do {
    let mem = memoryWith(OPEN);
    let proposal = expectOk(
        Trades.beginPropose(mem, { peer = bob; want_design_id = 1; offer = #own(1) }, alice, 100)
    );
    ignore expectOk(
        Trades.finishPropose(mem, proposal.request_id, ?#minted({ chip = peerChip(7) }), alice, 200)
    );

    if (Map.size(mem.outgoing) != 0) Runtime.trap("a settled trade stayed in the live table");
    let entry = onlyEntry(mem);
    if (entry.outcome != #traded) Runtime.trap("a completed trade was not recorded as traded");
    if (entry.direction != #outgoing) Runtime.trap("direction is wrong");
    let ?theirs = entry.theirs else Runtime.trap("their side was not recorded");
    if (theirs.ref.serial != 7) Runtime.trap("their chip was not recorded");
    if (theirs.title != "Peer chip") Runtime.trap("their title was not recorded");
    if (entry.ours == null) Runtime.trap("our side was not recorded");
    if (entry.started_at_ns != 100) Runtime.trap("the start time is wrong");
    if (entry.settled_at_ns != 200) Runtime.trap("the settle time is wrong");
    // Our offer was minted from our own design, so nothing was escrowed.
    if (entry.escrow_key != null) Runtime.trap("a minted offer claimed an escrow");
};

// --- A peer's refusal is recorded with their reason -----------------------

do {
    let mem = memoryWith(OPEN);
    let proposal = expectOk(
        Trades.beginPropose(mem, { peer = bob; want_design_id = 1; offer = #own(1) }, alice, 100)
    );
    ignore expectOk(
        Trades.finishPropose(mem, proposal.request_id, ?#declined({ reason = "min_colors" }), alice, 300)
    );

    let entry = onlyEntry(mem);
    if (entry.outcome != #declined_by_peer("min_colors")) {
        Runtime.trap("a refusal lost the peer's reason");
    };
    if (entry.theirs != null) Runtime.trap("a refusal invented a chip on their side");
    if (entry.ours == null) Runtime.trap("a refusal forgot what we offered");
};

// --- Giving up records an unresolved trade and leaves the chip alone -------

do {
    let mem = memoryWith(OPEN);
    let proposal = expectOk(
        Trades.beginPropose(mem, { peer = bob; want_design_id = 1; offer = #own(1) }, alice, 100)
    );
    // A lost reply is the only way a trade becomes uncertain.
    ignore expectOk(Trades.finishPropose(mem, proposal.request_id, null, alice, 200));
    if (Map.size(mem.outgoing) != 1) Runtime.trap("an uncertain trade should stay live");

    ignore expectOk(Trades.abandonOutgoing(mem, proposal.request_id, 400));
    if (Map.size(mem.outgoing) != 0) Runtime.trap("giving up did not free the slot");
    let entry = onlyEntry(mem);
    if (entry.outcome != #unresolved) Runtime.trap("giving up did not record an unresolved trade");

    // An unresolved entry is still answerable later.
    if (Trades.findUnresolved(mem, proposal.request_id) == null) {
        Runtime.trap("an unresolved entry cannot be found again");
    };
};

// --- A declined inbound offer names the chip we turned down ---------------

do {
    // Manual approval is what puts an offer in the incoming table.
    let mem = memoryWith(APPROVES);
    let id = requestId(9);
    ignore Trades.acceptInbound(
        mem,
        { request_id = id; want_design_id = 1; offered = peerChip(11) },
        bob,
        alice,
        100,
    );
    if (Map.size(mem.incoming) != 1) Runtime.trap("the offer did not wait for approval");
    ignore expectOk(Trades.declinePending(mem, id, 200));
    ignore expectOk(Trades.completeDelivery(mem, id, alice, 300));

    if (Map.size(mem.incoming) != 0) Runtime.trap("a settled offer stayed in the live table");
    let entry = onlyEntry(mem);
    if (entry.direction != #incoming) Runtime.trap("direction is wrong");
    if (entry.outcome != #declined_by_owner) Runtime.trap("our refusal was not recorded");
    let ?theirs = entry.theirs else Runtime.trap("we forgot the chip we turned down");
    if (theirs.ref.serial != 11) Runtime.trap("the refused chip is wrong");
    if (entry.ours != null) Runtime.trap("we claimed to have given a chip we never minted");
};

// --- An accepted inbound offer records the mint we handed over ------------

do {
    let mem = memoryWith(APPROVES);
    let id = requestId(21);
    ignore Trades.acceptInbound(
        mem,
        { request_id = id; want_design_id = 1; offered = peerChip(12) },
        bob,
        alice,
        100,
    );
    ignore expectOk(Trades.acceptPending(mem, id, alice, 200));
    ignore expectOk(Trades.completeDelivery(mem, id, alice, 300));

    let entry = onlyEntry(mem);
    if (entry.outcome != #traded) Runtime.trap("an accepted offer was not recorded as traded");
    let ?ours = entry.ours else Runtime.trap("we forgot the chip we minted");
    if (ours.title != "Ours") Runtime.trap("our mint lost its title");
    if (not Principal.equal(ours.ref.designer, alice)) Runtime.trap("our mint is not ours");
    let ?theirs = entry.theirs else Runtime.trap("we forgot what we received");
    if (theirs.ref.serial != 12) Runtime.trap("their chip is wrong");
};

// --- A repeat delivery for a settled trade is still answered --------------

do {
    let mem = memoryWith(OPEN);
    let proposal = expectOk(
        Trades.beginPropose(mem, { peer = bob; want_design_id = 1; offer = #own(1) }, alice, 100)
    );
    ignore expectOk(
        Trades.finishPropose(mem, proposal.request_id, ?#minted({ chip = peerChip(7) }), alice, 200)
    );
    // The row is gone, but the peer does not know that. Saying the trade already
    // finished is what stops them retrying; an error would not.
    let again = expectOk(
        Trades.deliverInbound(mem, proposal.request_id, bob, #minted(peerChip(7)), 400)
    );
    if (again != "already_final") Runtime.trap("a settled trade did not answer a repeat delivery");
    if (Trades.historyPage(mem, 0, 100).total != 1) Runtime.trap("a repeat delivery added a record");
};

// --- Eviction drops the oldest and never refuses --------------------------

do {
    let mem = Memory.init();
    var index = 0;
    while (index < Trades.MAX_HISTORY + 5) {
        ignore Trades.recordHistory(
            mem,
            #outgoing,
            bob,
            requestId(index),
            1,
            null,
            null,
            null,
            #unresolved,
            index,
            index,
        );
        index += 1;
    };
    let page = Trades.historyPage(mem, 0, 1000);
    if (page.total != Trades.MAX_HISTORY) Runtime.trap("history grew past its cap");
    // Newest first, so the first row is the last one written.
    if (page.entries[0].started_at_ns != Trades.MAX_HISTORY + 4) {
        Runtime.trap("the newest entry was not kept");
    };
    // The five oldest were the ones dropped.
    if (page.entries[page.entries.size() - 1].started_at_ns != 5) {
        Runtime.trap("eviction did not drop the oldest");
    };
};

// --- Forgetting: one at a time, and a clear that spares the unresolved -----

do {
    let mem = Memory.init();
    let settled = Trades.recordHistory(mem, #outgoing, bob, requestId(1), 1, null, null, null, #traded, 10, 10);
    let stuck = Trades.recordHistory(mem, #outgoing, bob, requestId(2), 1, null, null, null, #unresolved, 20, 20);

    ignore expectOk(Trades.forgetHistory(mem, settled));
    if (Trades.historyPage(mem, 0, 100).total != 1) Runtime.trap("forgetting one removed the wrong count");
    switch (Trades.forgetHistory(mem, settled)) {
        case (#ok(())) Runtime.trap("forgetting a missing entry should fail");
        case (#err(code)) if (code != "unknown_entry") Runtime.trap("wrong code: " # code);
    };

    // An unresolved entry is the last thing naming a chip still escrowed, so a
    // bulk clear must not be what strands it.
    ignore Trades.recordHistory(mem, #outgoing, bob, requestId(3), 1, null, null, null, #traded, 30, 30);
    if (Trades.clearHistory(mem) != 1) Runtime.trap("clear removed the wrong number");
    let left = Trades.historyPage(mem, 0, 100);
    if (left.total != 1) Runtime.trap("clear did not leave the unresolved entry");
    if (left.entries[0].entry_id != stuck) Runtime.trap("clear kept the wrong entry");

    // Individually, it can still go: the owner may genuinely want it gone.
    ignore expectOk(Trades.forgetHistory(mem, stuck));
    if (Trades.historyPage(mem, 0, 100).total != 0) Runtime.trap("an unresolved entry could not be forgotten");
};
