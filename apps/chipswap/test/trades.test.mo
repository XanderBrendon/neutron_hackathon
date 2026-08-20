import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Designs "../backend/Designs";
import Directory "../backend/Directory";
import Holdings "../backend/Holdings";
import Memory "../backend/memory/chipswap/v5";
import Shape "../backend/Shape";
import Trades "../backend/Trades";
import Wire "../backend/Wire";

func principalOf(seed : Nat) : Principal {
    Principal.fromBlob(Blob.fromArray([Nat8.fromNat(seed), 0, 0, 0, 0, 0, 0, 0, 1, 1]));
};

let alice = principalOf(1); // the designer under test
let bob = principalOf(2); // the peer
let carol = principalOf(3);

let art : Wire.Art = {
    shape_id = Shape.SHAPE_ID;
    palette = [0x101010, 0xffffff];
    pixels = Blob.fromArray(Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(i) { Nat8.fromNat(i % 2) }));
};

func offeredChip(designer : Principal, designId : Nat, serial : Nat) : Wire.Chip {
    {
        designer;
        design_id = designId;
        serial;
        title = "Peer chip";
        art;
        nsfw = false;
        design_revision = 1;
        minted_at_ns = 50;
    };
};

func requestId(seed : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(16, func(i) { Nat8.fromNat((seed + i) % 256) }));
};

func expectOk<T>(result : Trades.Result<T>) : T {
    switch (result) {
        case (#ok(value)) value;
        case (#err(code)) Runtime.trap("unexpected error: " # code);
    };
};

func expectErr<T>(result : Trades.Result<T>) : Text {
    switch (result) {
        case (#ok(_)) Runtime.trap("expected an error");
        case (#err(code)) code;
    };
};

let OPEN = Memory.openRequirements();
let APPROVES = { OPEN with approval = true };

// A designer canister with one published design under the given policy.
func policyMemory(requirements : Memory.TradeRequirements, nsfw : Bool) : Memory.Mem {
    let mem = Memory.init();
    switch (Designs.create(mem, "Auto chip", 10)) {
        case (#ok(_)) {};
        case (#err(code)) Runtime.trap(code);
    };
    switch (Designs.publish(mem, 1, 1, requirements, nsfw, 20)) {
        case (#ok(())) {};
        case (#err(code)) Runtime.trap(code);
    };
    mem;
};

func designerMemory(autoMode : Bool) : Memory.Mem {
    policyMemory(if (autoMode) OPEN else APPROVES, false);
};

func inbound(id : Blob, designId : Nat, chip : Wire.Chip) : Trades.InboundTrade {
    { request_id = id; want_design_id = designId; offered = chip };
};

// --- Auto mode: mint and return in the same reply -------------------------

let auto = designerMemory(true);
let firstRequest = requestId(1);
let firstOffer = offeredChip(bob, 4, 9);
let autoReply = Trades.acceptInbound(auto, inbound(firstRequest, 1, firstOffer), bob, alice, 100);
switch (autoReply) {
    case (#minted(payload)) {
        assert (payload.chip.designer == alice);
        assert (payload.chip.design_id == 1);
        assert (payload.chip.serial == 1);
        assert (payload.chip.minted_at_ns == 100);
    };
    case (_) Runtime.trap("expected minted");
};
// Their chip is ours now, and the peer is known. Only the peer: a proposal
// carries no directory any more, so carol arrives only if we go and look.
assert (Holdings.count(auto) == 1);
assert (Holdings.get(auto, Holdings.key({ designer = bob; design_id = 4; serial = 9 })) != null);
assert (Directory.get(auto, bob) != null);
assert (Directory.get(auto, carol) == null);
assert (Map.size(auto.replay) == 1);

// Replaying the exact request returns the stored outcome and mints nothing new.
let replayReply = Trades.acceptInbound(auto, inbound(firstRequest, 1, firstOffer), bob, alice, 150);
switch (replayReply) {
    case (#minted(payload)) {
        assert (payload.chip.serial == 1);
        assert (payload.chip.minted_at_ns == 100);
    };
    case (_) Runtime.trap("expected replayed mint");
};
assert (Holdings.count(auto) == 1);
let ?autoDesign = Designs.get(auto, 1) else Runtime.trap("design missing");
assert (autoDesign.next_serial == 2);

// A different request from the same peer is a new trade.
switch (Trades.acceptInbound(auto, inbound(requestId(2), 1, offeredChip(bob, 4, 10)), bob, alice, 160)) {
    case (#minted(payload)) assert (payload.chip.serial == 2);
    case (_) Runtime.trap("expected minted");
};

// Rejections: ourselves, unknown design, unpublished design, malformed art.
switch (Trades.acceptInbound(auto, inbound(requestId(3), 1, firstOffer), alice, alice, 170)) {
    case (#err(payload)) assert (payload.code == "self_trade");
    case (_) Runtime.trap("expected self_trade");
};
switch (Trades.acceptInbound(auto, inbound(requestId(4), 9, offeredChip(bob, 4, 11)), bob, alice, 180)) {
    case (#declined(payload)) assert (payload.reason == "unknown_design");
    case (_) Runtime.trap("expected unknown_design");
};
switch (Designs.create(auto, "Draft only", 190)) {
    case (#ok(slot)) assert (slot == 2);
    case (#err(code)) Runtime.trap(code);
};
switch (Trades.acceptInbound(auto, inbound(requestId(5), 2, offeredChip(bob, 4, 12)), bob, alice, 200)) {
    case (#declined(payload)) assert (payload.reason == "unknown_design");
    case (_) Runtime.trap("expected unknown_design for a draft");
};
let brokenArt : Wire.Chip = {
    offeredChip(bob, 4, 13) with
    art = { art with pixels = Blob.fromArray([1, 2, 3]) }
};
switch (Trades.acceptInbound(auto, inbound(requestId(6), 1, brokenArt), bob, alice, 210)) {
    case (#err(payload)) assert (payload.code == "invalid_offer");
    case (_) Runtime.trap("expected invalid_offer");
};
switch (Trades.acceptInbound(auto, inbound(Blob.fromArray([1, 2, 3]), 1, offeredChip(bob, 4, 14)), bob, alice, 220)) {
    case (#err(payload)) assert (payload.code == "invalid_request");
    case (_) Runtime.trap("expected invalid_request");
};
// The same instance cannot be delivered to us twice.
switch (Trades.acceptInbound(auto, inbound(requestId(7), 1, firstOffer), bob, alice, 230)) {
    case (#declined(payload)) assert (payload.reason == "duplicate_offer");
    case (_) Runtime.trap("expected duplicate_offer");
};

// --- Requirements refuse an offer before anything is held ------------------

// The art in these tests alternates two colors pixel by pixel, so it is two
// colors with the larger holding 379 of the 757: a hair over half.
let picky = policyMemory(
    { OPEN with min_colors = ?3; max_coverage = ?50; nsfw = ? #disallowed },
    false,
);
switch (Trades.acceptInbound(picky, inbound(requestId(20), 1, offeredChip(bob, 4, 20)), bob, alice, 300)) {
    case (#declined(payload)) assert (payload.reason == "min_colors");
    case (_) Runtime.trap("expected min_colors");
};
// Nothing was admitted, nothing was minted, and no replay was recorded: a
// refusal leaves the designer exactly where it was.
assert (Holdings.count(picky) == 0);
assert (Map.size(picky.incoming) == 0);
assert (Map.size(picky.replay) == 0);
let ?pickyDesign = Designs.get(picky, 1) else Runtime.trap("design missing");
assert (pickyDesign.next_serial == 1);

// Three colors clears the minimum, but one of them covers 400 of 757.
let threeColors : Wire.Art = {
    shape_id = Shape.SHAPE_ID;
    palette = [0x101010, 0xffffff, 0x7fd1c1];
    pixels = Blob.fromArray(
        Array.tabulate<Nat8>(
            Shape.PIXEL_COUNT,
            func(i) { if (i < 400) 0 else if (i < 600) 1 else 2 },
        )
    );
};
switch (
    Trades.acceptInbound(
        picky,
        inbound(requestId(21), 1, { offeredChip(bob, 4, 21) with art = threeColors }),
        bob,
        alice,
        310,
    )
) {
    case (#declined(payload)) assert (payload.reason == "max_coverage");
    case (_) Runtime.trap("expected max_coverage");
};

// Spread more evenly it clears the cap, but the tag refuses it.
let evenColors : Wire.Art = {
    threeColors with
    pixels = Blob.fromArray(
        Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(i) { Nat8.fromNat(i % 3) })
    )
};
switch (
    Trades.acceptInbound(
        picky,
        inbound(
            requestId(22),
            1,
            { offeredChip(bob, 4, 22) with art = evenColors; nsfw = true },
        ),
        bob,
        alice,
        320,
    )
) {
    case (#declined(payload)) assert (payload.reason == "nsfw_disallowed");
    case (_) Runtime.trap("expected nsfw_disallowed");
};

// The same chip untagged satisfies everything and the trade completes.
switch (
    Trades.acceptInbound(
        picky,
        inbound(requestId(23), 1, { offeredChip(bob, 4, 23) with art = evenColors }),
        bob,
        alice,
        330,
    )
) {
    case (#minted(payload)) assert (payload.chip.serial == 1);
    case (_) Runtime.trap("expected minted");
};
assert (Holdings.count(picky) == 1);

// A design that requires the tag refuses what the one above accepted.
let wantsTagged = policyMemory({ OPEN with nsfw = ? #required }, true);
switch (
    Trades.acceptInbound(
        wantsTagged,
        inbound(requestId(24), 1, { offeredChip(bob, 4, 24) with art = evenColors }),
        bob,
        alice,
        340,
    )
) {
    case (#declined(payload)) assert (payload.reason == "nsfw_required");
    case (_) Runtime.trap("expected nsfw_required");
};

// Requirements are settled before approval, so an offer that fails one is
// refused rather than held for a designer who would only decline it.
let pickyApproving = policyMemory({ OPEN with approval = true; min_colors = ?3 }, false);
switch (
    Trades.acceptInbound(pickyApproving, inbound(requestId(25), 1, offeredChip(bob, 4, 25)), bob, alice, 350)
) {
    case (#declined(payload)) assert (payload.reason == "min_colors");
    case (_) Runtime.trap("expected min_colors before approval");
};
assert (Map.size(pickyApproving.incoming) == 0);
// The same design holds an offer that qualifies.
switch (
    Trades.acceptInbound(
        pickyApproving,
        inbound(requestId(26), 1, { offeredChip(bob, 4, 26) with art = evenColors }),
        bob,
        alice,
        360,
    )
) {
    case (#pending(_)) {};
    case (_) Runtime.trap("expected pending");
};
assert (Map.size(pickyApproving.incoming) == 1);

// A chip minted from a tagged design carries the tag to the peer, and keeps it
// even after the designer retags the design.
let tagged = policyMemory(OPEN, true);
switch (
    Trades.acceptInbound(
        tagged,
        inbound(requestId(27), 1, { offeredChip(bob, 4, 27) with art = evenColors }),
        bob,
        alice,
        370,
    )
) {
    case (#minted(payload)) assert (payload.chip.nsfw);
    case (_) Runtime.trap("expected a tagged mint");
};
switch (Designs.setTradePolicy(tagged, 1, OPEN, false)) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
switch (
    Trades.acceptInbound(
        tagged,
        inbound(requestId(27), 1, { offeredChip(bob, 4, 27) with art = evenColors }),
        bob,
        alice,
        380,
    )
) {
    case (#minted(payload)) assert (payload.chip.nsfw);
    case (_) Runtime.trap("expected the replayed chip to keep its tag");
};

// --- Manual mode: escrow, then accept -------------------------------------

let manual = designerMemory(false);
let manualRequest = requestId(20);
let manualOffer = offeredChip(bob, 7, 3);
switch (Trades.acceptInbound(manual, inbound(manualRequest, 1, manualOffer), bob, alice, 300)) {
    case (#pending(_)) {};
    case (_) Runtime.trap("expected pending");
};
// The offered chip is escrowed in the trade, not in the collection.
assert (Holdings.count(manual) == 0);
assert (Trades.pendingIncoming(manual).size() == 1);
let ?manualDesign = Designs.get(manual, 1) else Runtime.trap("design missing");
assert (manualDesign.next_serial == 1);

// A status query while pending reports pending.
assert (Trades.statusOf(manual, manualRequest, bob, alice) == #pending);
assert (Trades.statusOf(manual, requestId(99), bob, alice) == #unknown);
assert (Trades.statusOf(manual, manualRequest, carol, alice) == #unknown);

// Accepting mints, admits the offered chip, and yields the delivery payload.
let accepted = expectOk(Trades.acceptPending(manual, manualRequest, alice, 310));
assert (accepted.peer == bob);
assert (accepted.chip.serial == 1);
assert (accepted.chip.minted_at_ns == 310);
assert (Holdings.count(manual) == 1);
assert (Holdings.get(manual, Holdings.key({ designer = bob; design_id = 7; serial = 3 })) != null);

// The delivery payload is rebuildable, so a failed send can be retried exactly.
let retry = expectOk(Trades.retryDelivery(manual, manualRequest, alice));
assert (retry.chip.serial == accepted.chip.serial);
assert (retry.chip.minted_at_ns == accepted.chip.minted_at_ns);
switch (retry.outcome) {
    case (#minted(_)) {};
    case (_) Runtime.trap("expected a mint delivery");
};

// Status now reports the mint, with the same chip a retry would send.
switch (Trades.statusOf(manual, manualRequest, bob, alice)) {
    case (#minted(payload)) {
        assert (payload.chip.serial == 1);
        assert (payload.chip.minted_at_ns == 310);
    };
    case (_) Runtime.trap("expected minted status");
};
assert (expectErr(Trades.acceptPending(manual, manualRequest, alice, 320)) == "not_pending");
assert (expectOk(Trades.completeDelivery(manual, manualRequest)) == ());
assert (Trades.pendingIncoming(manual).size() == 0);
// The outcome survives the record, so a late status query still answers.
switch (Trades.statusOf(manual, manualRequest, bob, alice)) {
    case (#minted(payload)) assert (payload.chip.serial == 1);
    case (_) Runtime.trap("expected minted status after completion");
};

// --- Manual mode: decline returns the offered chip ------------------------

let declining = designerMemory(false);
let declineRequest = requestId(40);
let declineOffer = offeredChip(bob, 2, 2);
switch (Trades.acceptInbound(declining, inbound(declineRequest, 1, declineOffer), bob, alice, 400)) {
    case (#pending(_)) {};
    case (_) Runtime.trap("expected pending");
};
let declined = expectOk(Trades.declinePending(declining, declineRequest, 410));
assert (declined.peer == bob);
switch (declined.outcome) {
    case (#returned(chip)) {
        assert (chip.designer == bob);
        assert (chip.design_id == 2);
        assert (chip.serial == 2);
    };
    case (_) Runtime.trap("expected the offered chip back");
};
// We never keep a declined offer.
assert (Holdings.count(declining) == 0);
assert (Trades.statusOf(declining, declineRequest, bob, alice) == #declined({ reason = "designer_declined" }));
assert (expectOk(Trades.completeDelivery(declining, declineRequest)) == ());
assert (Trades.pendingIncoming(declining).size() == 0);

// --- Proposing: own designs mint, acquired chips are escrowed -------------

let proposer = Memory.init();
switch (Designs.create(proposer, "Mine", 10)) {
    case (#ok(_)) {};
    case (#err(code)) Runtime.trap(code);
};
switch (Designs.publish(proposer, 1, 1, OPEN, false, 20)) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
Directory.storeCatalog(
    proposer,
    alice,
    [{
        design_id = 1;
        title = "Alice chip";
        art;
        requirements = OPEN;
        nsfw = false;
        design_revision = 1;
        published_at_ns = 5;
    }],
    30,
);
switch (Holdings.admit(proposer, Trades.chipFromWire(offeredChip(carol, 5, 1), 40))) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};

// Offering one of our own designs mints a fresh copy and escrows nothing.
let ownProposal = expectOk(
    Trades.beginPropose(
        proposer,
        { peer = alice; want_design_id = 1; offer = #own(1) },
        bob,
        100,
    )
);
assert (ownProposal.offered.designer == bob);
assert (ownProposal.offered.serial == 1);
assert (ownProposal.request_id.size() == 16);
assert (Holdings.count(proposer) == 1);
let ?heldCarol = Holdings.get(proposer, Holdings.key({ designer = carol; design_id = 5; serial = 1 }))
else Runtime.trap("chip missing");
assert (heldCarol.state == #held);

// Trading an acquired chip escrows it: it is no longer spendable.
let carolKey = Holdings.key({ designer = carol; design_id = 5; serial = 1 });
let heldProposal = expectOk(
    Trades.beginPropose(
        proposer,
        { peer = alice; want_design_id = 1; offer = #held(carolKey) },
        bob,
        110,
    )
);
assert (heldProposal.offered.designer == carol);
assert (Holdings.spendable(proposer, carolKey) == false);
assert (
    expectErr(
        Trades.beginPropose(
            proposer,
            { peer = alice; want_design_id = 1; offer = #held(carolKey) },
            bob,
            120,
        )
    ) == "not_available"
);

// Guard rails on proposing.
assert (
    expectErr(
        Trades.beginPropose(proposer, { peer = bob; want_design_id = 1; offer = #own(1) }, bob, 130)
    ) == "self_trade"
);
assert (
    expectErr(
        Trades.beginPropose(proposer, { peer = alice; want_design_id = 8; offer = #own(1) }, bob, 140)
    ) == "unknown_design"
);
assert (
    expectErr(
        Trades.beginPropose(proposer, { peer = carol; want_design_id = 1; offer = #own(1) }, bob, 150)
    ) == "unknown_design"
);
assert (
    expectErr(
        Trades.beginPropose(proposer, { peer = alice; want_design_id = 1; offer = #own(9) }, bob, 160)
    ) == "not_found"
);
assert (
    expectErr(
        Trades.beginPropose(proposer, { peer = alice; want_design_id = 1; offer = #held("nope") }, bob, 170)
    ) == "not_found"
);

// --- Finishing a proposal --------------------------------------------------

let mintedBack : Wire.Chip = {
    designer = alice;
    design_id = 1;
    serial = 12;
    title = "Alice chip";
    art;
    nsfw = false;
    design_revision = 1;
    minted_at_ns = 200;
};
assert (
    expectOk(
        Trades.finishPropose(
            proposer,
            heldProposal.request_id,
            ?#minted({ chip = mintedBack }),
            bob,
            210,
        )
    ) == "completed"
);
// The escrowed chip is gone and the new one arrived.
assert (Holdings.get(proposer, carolKey) == null);
assert (Holdings.get(proposer, Holdings.key({ designer = alice; design_id = 1; serial = 12 })) != null);

// A pending reply keeps the offer escrowed.
let pendingProposal = expectOk(
    Trades.beginPropose(proposer, { peer = alice; want_design_id = 1; offer = #own(1) }, bob, 220)
);
assert (
    expectOk(
        Trades.finishPropose(proposer, pendingProposal.request_id, ?#pending, bob, 230)
    ) == "pending"
);

// A declined reply restores the escrowed chip.
let restoreKey = Holdings.key({ designer = alice; design_id = 1; serial = 12 });
let declinedProposal = expectOk(
    Trades.beginPropose(proposer, { peer = alice; want_design_id = 1; offer = #held(restoreKey) }, bob, 240)
);
assert (Holdings.spendable(proposer, restoreKey) == false);
assert (
    expectOk(
        Trades.finishPropose(
            proposer,
            declinedProposal.request_id,
            ?#declined({ reason = "trade_mode" }),
            bob,
            250,
        )
    ) == "declined"
);
assert (Holdings.spendable(proposer, restoreKey));

// A lost reply is uncertain: the chip is neither spendable nor assumed safe.
let uncertainProposal = expectOk(
    Trades.beginPropose(proposer, { peer = alice; want_design_id = 1; offer = #held(restoreKey) }, bob, 260)
);
assert (expectOk(Trades.finishPropose(proposer, uncertainProposal.request_id, null, bob, 270)) == "uncertain");
assert (Holdings.spendable(proposer, restoreKey) == false);
let ?uncertainChip = Holdings.get(proposer, restoreKey) else Runtime.trap("chip missing");
switch (uncertainChip.state) {
    case (#uncertain(_)) {};
    case (_) Runtime.trap("expected uncertain");
};

// Resolving with the designer's status is the only way out of uncertainty.
assert (expectOk(Trades.resolveOutgoing(proposer, uncertainProposal.request_id, null, 280)) == "uncertain");
assert (Holdings.spendable(proposer, restoreKey) == false);
assert (
    expectOk(Trades.resolveOutgoing(proposer, uncertainProposal.request_id, ?#unknown, 290)) == "not_received"
);
assert (Holdings.spendable(proposer, restoreKey));

// --- Delivery from the designer -------------------------------------------

let awaiting = expectOk(
    Trades.beginPropose(proposer, { peer = alice; want_design_id = 1; offer = #held(restoreKey) }, bob, 300)
);
assert (expectOk(Trades.finishPropose(proposer, awaiting.request_id, ?#pending, bob, 310)) == "pending");

let delivered : Wire.Chip = {
    designer = alice;
    design_id = 1;
    serial = 77;
    title = "Alice chip";
    art;
    nsfw = false;
    design_revision = 1;
    minted_at_ns = 320;
};
// Only the trade's own peer may complete it.
assert (
    expectErr(
        Trades.deliverInbound(proposer, awaiting.request_id, carol, #minted(delivered), 330)
    ) == "unknown_trade"
);
assert (
    expectOk(
        Trades.deliverInbound(proposer, awaiting.request_id, alice, #minted(delivered), 340)
    ) == "completed"
);
assert (Holdings.get(proposer, restoreKey) == null);
assert (Holdings.get(proposer, Holdings.key({ designer = alice; design_id = 1; serial = 77 })) != null);
// Delivery is idempotent, because a peer may retry after a lost reply.
assert (
    expectOk(
        Trades.deliverInbound(proposer, awaiting.request_id, alice, #minted(delivered), 350)
    ) == "already_final"
);

// A returned chip is released rather than admitted a second time.
let returning = expectOk(
    Trades.beginPropose(
        proposer,
        { peer = alice; want_design_id = 1; offer = #held(Holdings.key({ designer = alice; design_id = 1; serial = 77 })) },
        bob,
        360,
    )
);
assert (expectOk(Trades.finishPropose(proposer, returning.request_id, ?#pending, bob, 370)) == "pending");
assert (
    expectOk(
        Trades.deliverInbound(proposer, returning.request_id, alice, #returned(returning.offered), 380)
    ) == "returned"
);
assert (Holdings.spendable(proposer, Holdings.key({ designer = alice; design_id = 1; serial = 77 })));
// The returned instance is released, not admitted twice: still one chip.
assert (Holdings.count(proposer) == 1);

// --- Bounds ----------------------------------------------------------------

let bounded = designerMemory(false);
var index = 0;
while (index < Trades.MAX_INCOMING) {
    switch (
        Trades.acceptInbound(
            bounded,
            inbound(requestId(1000 + index), 1, offeredChip(bob, 1, index + 1)),
            bob,
            alice,
            500 + index,
        )
    ) {
        case (#pending(_)) {};
        case (_) Runtime.trap("expected pending");
    };
    index += 1;
};
assert (Trades.pendingIncoming(bounded).size() == Trades.MAX_INCOMING);
switch (
    Trades.acceptInbound(
        bounded,
        inbound(requestId(9000), 1, offeredChip(bob, 1, 999)),
        bob,
        alice,
        900,
    )
) {
    case (#declined(payload)) assert (payload.reason == "incoming_full");
    case (_) Runtime.trap("expected incoming_full");
};

let outgoingBound = Memory.init();
switch (Designs.create(outgoingBound, "Mine", 10)) {
    case (#ok(_)) {};
    case (#err(code)) Runtime.trap(code);
};
switch (Designs.publish(outgoingBound, 1, 1, OPEN, false, 20)) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
Directory.storeCatalog(
    outgoingBound,
    alice,
    [{
        design_id = 1;
        title = "Alice chip";
        art;
        requirements = OPEN;
        nsfw = false;
        design_revision = 1;
        published_at_ns = 5;
    }],
    30,
);
var outgoing = 0;
while (outgoing < Trades.MAX_OUTGOING) {
    ignore expectOk(
        Trades.beginPropose(
            outgoingBound,
            { peer = alice; want_design_id = 1; offer = #own(1) },
            bob,
            600 + outgoing,
        )
    );
    outgoing += 1;
};
assert (
    expectErr(
        Trades.beginPropose(
            outgoingBound,
            { peer = alice; want_design_id = 1; offer = #own(1) },
            bob,
            700,
        )
    ) == "outgoing_full"
);

// Request ids are unique per canister.
let ids = Trades.pendingOutgoing(outgoingBound);
assert (ids.size() == Trades.MAX_OUTGOING);
let keys = Array.map<Memory.OutgoingTrade, Text>(ids, func(trade) { Trades.outgoingKey(trade.request_id) });
let sorted = Array.sort<Text>(keys, Text.compare);
var scan = 1;
while (scan < sorted.size()) {
    assert (sorted[scan - 1] != sorted[scan]);
    scan += 1;
};

// --- A retired designer who turns out to be alive ---------------------------

// Retirement is a conclusion drawn from calls that went unanswered, and a trade
// proposal disproves it outright: whatever we concluded, they are running
// Chipswap and they just reached us. The chips we already hold from them are
// untouched either way — a chip is copied at the trade, not fetched later.
let reviving = designerMemory(true);
ignore Directory.note(reviving, bob, #manual, 1);
assert (Directory.noteUnreachable(reviving, bob, 2) == false);
assert (Directory.noteUnreachable(reviving, bob, 3) == false);
assert (Directory.noteUnreachable(reviving, bob, 4));
assert (Directory.retired(reviving, bob));

let revivalRequest = requestId(90);
switch (
    Trades.acceptInbound(
        reviving,
        inbound(revivalRequest, 1, offeredChip(bob, 4, 21)),
        bob,
        alice,
        400,
    )
) {
    case (#minted(_)) {};
    case (_) Runtime.trap("expected minted");
};
assert (Directory.retired(reviving, bob) == false);
let ?revived = Directory.get(reviving, bob) else Runtime.trap("missing entry");
assert (revived.strikes == 0);
assert (revived.last_seen_ns == 400);
// The designer was chosen by hand, and a revival does not rewrite that.
assert (revived.source == #manual);
assert (Holdings.count(reviving) == 1);

// Ignoring is the owner's instruction, not a conclusion, so nothing a peer does
// withdraws it. A proposal from an ignored designer is still answered — refusing
// to trade is a different decision from refusing to hear about them.
let ignoringPeer = designerMemory(true);
ignore Directory.note(ignoringPeer, bob, #manual, 1);
assert (Directory.setIgnored(ignoringPeer, bob, true));
switch (
    Trades.acceptInbound(
        ignoringPeer,
        inbound(requestId(91), 1, offeredChip(bob, 4, 22)),
        bob,
        alice,
        410,
    )
) {
    case (#minted(_)) {};
    case (_) Runtime.trap("expected minted");
};
assert (Directory.ignored(ignoringPeer, bob));
