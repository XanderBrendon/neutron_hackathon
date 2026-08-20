import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Holdings "../backend/Holdings";
import Memory "../backend/memory/chipswap/v3";
import Shape "../backend/Shape";

let alice = Principal.fromBlob(Blob.fromArray([0, 1, 1]));
let bob = Principal.fromBlob(Blob.fromArray([0, 2, 1]));
let requestId = Blob.fromArray(Array.tabulate<Nat8>(16, func(i) { Nat8.fromNat(i) }));

let art : Memory.Art = {
    shape_id = Shape.SHAPE_ID;
    palette = [0x000000, 0xffffff];
    pixels = Blob.fromArray(Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(_) { 1 }));
};

func chip(designer : Principal, designId : Nat, serial : Nat) : Memory.Chip {
    {
        ref = { designer; design_id = designId; serial };
        title = "Chip";
        art;
        nsfw = false;
        design_revision = 1;
        minted_at_ns = 10;
        acquired_at_ns = 20 + serial;
        state = #held;
    };
};

func expectOk<T>(result : Holdings.Result<T>) : T {
    switch (result) {
        case (#ok(value)) value;
        case (#err(code)) Runtime.trap("unexpected error: " # code);
    };
};

func expectErr<T>(result : Holdings.Result<T>) : Text {
    switch (result) {
        case (#ok(_)) Runtime.trap("expected an error");
        case (#err(code)) code;
    };
};

let mem = Memory.init();
assert (Holdings.count(mem) == 0);

// Keys identify a single minted instance.
let key = Holdings.key({ designer = alice; design_id = 2; serial = 5 });
assert (key == Holdings.key({ designer = alice; design_id = 2; serial = 5 }));
assert (key != Holdings.key({ designer = alice; design_id = 2; serial = 6 }));
assert (key != Holdings.key({ designer = bob; design_id = 2; serial = 5 }));

// Admission is idempotent-hostile: the same instance cannot arrive twice.
let aliceChip = chip(alice, 2, 5);
assert (expectOk(Holdings.admit(mem, aliceChip)) == ());
assert (Holdings.count(mem) == 1);
assert (expectErr(Holdings.admit(mem, aliceChip)) == "duplicate");
let ?stored = Holdings.get(mem, key) else Runtime.trap("chip missing");
assert (stored.ref.serial == 5);
assert (stored.state == #held);

// Escrow removes a chip from circulation without deleting it.
let escrowed = expectOk(Holdings.escrow(mem, key, requestId, bob, 500));
assert (escrowed.ref.serial == 5);
let ?afterEscrow = Holdings.get(mem, key) else Runtime.trap("chip missing");
switch (afterEscrow.state) {
    case (#escrowed(details)) {
        assert (details.peer == bob);
        assert (details.request_id == requestId);
        assert (details.since_ns == 500);
    };
    case (_) Runtime.trap("expected escrow");
};
assert (expectErr(Holdings.escrow(mem, key, requestId, bob, 510)) == "not_available");
assert (Holdings.spendable(mem, key) == false);

// An unconfirmed outcome is honestly uncertain, never silently restored.
assert (expectOk(Holdings.markUncertain(mem, key)) == ());
let ?afterUncertain = Holdings.get(mem, key) else Runtime.trap("chip missing");
switch (afterUncertain.state) {
    case (#uncertain(details)) assert (details.peer == bob);
    case (_) Runtime.trap("expected uncertain");
};

// Release returns an escrowed or uncertain chip to the collection.
assert (expectOk(Holdings.release(mem, key)) == ());
let ?afterRelease = Holdings.get(mem, key) else Runtime.trap("chip missing");
assert (afterRelease.state == #held);
assert (Holdings.spendable(mem, key));

// Consuming a traded-away chip removes it entirely.
ignore expectOk(Holdings.escrow(mem, key, requestId, bob, 520));
assert (expectOk(Holdings.consume(mem, key)) == ());
assert (Holdings.get(mem, key) == null);
assert (Holdings.count(mem) == 0);
assert (expectErr(Holdings.consume(mem, key)) == "not_found");
assert (expectErr(Holdings.escrow(mem, key, requestId, bob, 530)) == "not_found");
assert (expectErr(Holdings.release(mem, key)) == "not_found");

// Ownership questions drive the store filters.
assert (expectOk(Holdings.admit(mem, chip(alice, 2, 7))) == ());
assert (Holdings.ownsDesign(mem, alice, 2));
assert (Holdings.ownsDesign(mem, alice, 3) == false);
assert (Holdings.ownsAnyFrom(mem, alice));
assert (Holdings.ownsAnyFrom(mem, bob) == false);

// Paging is deterministic and reports the unpaged total.
assert (expectOk(Holdings.admit(mem, chip(bob, 1, 1))) == ());
assert (expectOk(Holdings.admit(mem, chip(bob, 1, 2))) == ());
let page = Holdings.page(mem, 0, 2);
assert (page.total == 3);
assert (page.chips.size() == 2);
let second = Holdings.page(mem, 2, 2);
assert (second.total == 3);
assert (second.chips.size() == 1);
assert (Holdings.page(mem, 9, 2).chips.size() == 0);
assert (page.chips[0].ref != page.chips[1].ref);

// The table is bounded.
var serial = 100;
while (Holdings.count(mem) < Holdings.MAX_HOLDINGS) {
    assert (expectOk(Holdings.admit(mem, chip(bob, 9, serial))) == ());
    serial += 1;
};
assert (Holdings.count(mem) == Holdings.MAX_HOLDINGS);
assert (expectErr(Holdings.admit(mem, chip(bob, 9, serial))) == "holdings_full");
