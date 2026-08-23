# Chipswap Trade History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settled trades leave the live tables for a new `mem.history` root in both directions, the Trades page shows that history, and the owner can forget entries.

**Architecture:** A new memory schema (v9) adds `history : Map.Map<Nat, HistoryEntry>` and drops the three terminal variants from `OutgoingState`, so a settled outgoing trade cannot be stored in the live table at all. Every terminal outgoing transition funnels through one `settleOutgoing` helper that removes the row and writes the entry as one act; the inbound side writes its entry at the single point where `completeDelivery` already deletes the row. Four new endpoints read and prune the history, and `trades.tsx` grows a third panel.

**Tech Stack:** Motoko (`mo:core`), the Neutron app manifest and managed-memory migration system, TypeScript + React + `neutron-design-system`, Bun for the JS test runner, `run_motoko_program.ts` for Motoko tests.

**Spec:** `docs/superpowers/specs/2026-08-23-chipswap-trade-history-design.md`

## Global Constraints

- Work in `apps/chipswap/`. All paths below are relative to that directory unless they start with `docs/`.
- **Never edit a released schema or migration module.** `backend/memory/chipswap/v1.mo` through `v8.mo` and every `vN_to_vN+1.mo` up to `v7_to_v8.mo` are immutable history. Only `v9.mo` and `v8_to_v9.mo` are new files.
- Memory schema modules may import packages (`mo:core/...`) and sibling schema modules (`./v8`). They must **not** import app modules (`../../Holdings`). Duplicate any needed helper inline.
- `MAX_HISTORY = 256`. Recording a trade must never fail.
- `clearHistory` removes every entry **except** `#unresolved` ones.
- New Motoko test files must be added to the `test:motoko` script in `package.json` or they never run.
- Motoko test files are scripts, not modules: top-level `let`/`if`/`Runtime.trap`, no `module { }` wrapper. Follow `test/memory_v8.test.mo`.
- Existing style: 4-space indent in `.mo`, 2-space in `.ts`/`.tsx`. Comments explain *why*, not *what*.
- Run `npm run test:motoko` from `apps/chipswap/` for Motoko tests, `bun test` for JS tests.

---

### Task 1: Memory schema v9 and its migration

**Files:**
- Create: `backend/memory/chipswap/v9.mo`
- Create: `backend/memory/chipswap/v8_to_v9.mo`
- Create: `test/memory_v9.test.mo`
- Modify: `package.json` (the `test:motoko` script)

**Interfaces:**
- Consumes: `backend/memory/chipswap/v8.mo` (read only, never edited).
- Produces: `V9.Mem` with `history : Map.Map<Nat, HistoryEntry>` and `var next_history_id : Nat`; `V9.HistoryEntry`, `V9.HistoryChip`, `V9.HistoryOutcome`, `V9.HistoryDirection`; `V9.OutgoingState = {#sending; #pending_designer; #uncertain}`; `Migrate.migrate(old : V8.Mem) : V9.Mem`.

Nothing else imports v9 after this task, so the tree still compiles against v8 throughout.

- [ ] **Step 1: Write the failing migration test**

Create `test/memory_v9.test.mo`:

```motoko
import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import V8 "../backend/memory/chipswap/v8";
import V9 "../backend/memory/chipswap/v9";
import Migrate "../backend/memory/chipswap/v8_to_v9";

// V9 gives a settled trade somewhere to live. Until now an outgoing trade that
// finished sat in `outgoing` next to the trades still in flight, and an
// incoming one was deleted outright, so the owner could see an offer they made
// weeks ago and never the trade they accepted an hour ago.
//
// The migration is not a reset. Terminal outgoing rows hold real trades and
// they convert; the inbound side starts empty because those rows were already
// deleted and inventing them would put trades in the ledger that this canister
// cannot show ever happened.

let peer = Principal.fromBlob("\00\01\01");
let other = Principal.fromBlob("\00\02\01");

func ref(designId : Nat, serial : Nat) : V8.ChipRef {
    { designer = peer; design_id = designId; serial };
};

let old = V8.init();
old.revision := 12;
old.next_request_seq := 5;
old.next_brush_id := 2;

func addOutgoing(key : Text, state : V8.OutgoingState, created : Nat) {
    Map.add(
        old.outgoing,
        Text.compare,
        key,
        {
            request_id = "\01\02";
            peer;
            want_design_id = 3;
            offered_key = ?("offered-" # key);
            offered_ref = ref(9, 4);
            offered_title = "Offered " # key;
            state;
            created_at_ns = created;
            updated_at_ns = created + 100;
        } : V8.OutgoingTrade,
    );
};

// Two live rows, three settled ones, deliberately out of chronological order.
addOutgoing("live-a", #sending, 500);
addOutgoing("done", #completed(ref(3, 7)), 100);
addOutgoing("live-b", #uncertain, 600);
addOutgoing("refused", #declined("designer_declined"), 300);
addOutgoing("broke", #failed("holdings_full"), 200);

let fresh : V9.Mem = Migrate.migrate(old);

// Scalars carry across untouched.
if (fresh.revision != 12) Runtime.trap("revision did not carry across");
if (fresh.next_request_seq != 5) Runtime.trap("request sequence did not carry across");
if (fresh.next_brush_id != 2) Runtime.trap("brush id did not carry across");

// The live table keeps only work in progress.
if (Map.size(fresh.outgoing) != 2) Runtime.trap("live rows did not survive alone");
if (Map.get(fresh.outgoing, Text.compare, "live-a") == null) Runtime.trap("a sending row was dropped");
if (Map.get(fresh.outgoing, Text.compare, "live-b") == null) Runtime.trap("an uncertain row was dropped");

// The settled ones became history, oldest first, with ids from one.
if (Map.size(fresh.history) != 3) Runtime.trap("settled rows did not become history");
if (fresh.next_history_id != 4) Runtime.trap("the next id does not follow the entries");

let entries = Array.sort<(Nat, V9.HistoryEntry)>(
    Map.toArray(fresh.history),
    func(left, right) { Nat.compare(left.0, right.0) },
);

// created_at_ns order: done (100), broke (200), refused (300).
if (entries[0].1.entry_id != 1) Runtime.trap("ids do not start at one");
if (entries[0].1.started_at_ns != 100) Runtime.trap("entries are not in created order");
if (entries[1].1.started_at_ns != 200) Runtime.trap("entries are not in created order");
if (entries[2].1.started_at_ns != 300) Runtime.trap("entries are not in created order");

let completed = entries[0].1;
if (completed.direction != #outgoing) Runtime.trap("a migrated entry lost its direction");
if (completed.outcome != #traded) Runtime.trap("a completed trade is not recorded as traded");
if (completed.settled_at_ns != 200) Runtime.trap("settled time is not the row's updated time");
let ?ours = completed.ours else Runtime.trap("a completed trade forgot our side");
if (ours.title != "Offered done") Runtime.trap("our side lost its title");
if (ours.ref.serial != 4) Runtime.trap("our side lost its ref");
let ?theirs = completed.theirs else Runtime.trap("a completed trade forgot their side");
if (theirs.ref.design_id != 3 or theirs.ref.serial != 7) Runtime.trap("their side lost its ref");
if (completed.escrow_key != ?"offered-done") Runtime.trap("the escrow key did not carry across");

// A declined trade keeps the peer's reason and names no chip on their side,
// because they never minted one.
let refused = entries[2].1;
if (refused.outcome != #declined_by_peer("designer_declined")) {
    Runtime.trap("a declined trade lost its reason");
};
if (refused.theirs != null) Runtime.trap("a declined trade invented a chip");
if (refused.ours == null) Runtime.trap("a declined trade forgot what was offered");

let broke = entries[1].1;
if (broke.outcome != #failed("holdings_full")) Runtime.trap("a failed trade lost its code");

// Nothing reconstructs the inbound side: those rows were deleted on delivery.
for ((_, entry) in Map.entries(fresh.history)) {
    if (entry.direction == #incoming) Runtime.trap("the migration invented an inbound trade");
};

// A clean V9 install starts with an empty ledger and the seed designer intact.
let clean = V9.init();
if (Map.size(clean.history) != 0) Runtime.trap("a clean install invented history");
if (clean.next_history_id != 1) Runtime.trap("a clean install does not start ids at one");
if (Map.size(clean.directory) != 1) Runtime.trap("V9 install lost its seed");
let ?seed = Map.get(clean.directory, Principal.compare, V9.seedDesigner()) else {
    Runtime.trap("V9 seed is not the seed designer");
};
if (seed.source != #seed) Runtime.trap("V9 seed does not say it is a seed");
if (clean.revision != 0) Runtime.trap("V9 install did not start at revision zero");
if (Map.size(clean.designs) != 0) Runtime.trap("V9 install invented designs");
if (List.size(clean.brushes) != 0) Runtime.trap("V9 install invented brushes");
```

- [ ] **Step 2: Register the test so it actually runs**

In `package.json`, the `test:motoko` script lists every file it runs. Add `test/memory_v9.test.mo` immediately after `test/memory_v8.test.mo`:

```
"test:motoko": "bun ../../packages/neutron-scripts/src/run_motoko_program.ts test/shape.test.mo test/memory.test.mo test/memory_v4.test.mo test/memory_v5.test.mo test/memory_v6.test.mo test/memory_v7.test.mo test/memory_v8.test.mo test/memory_v9.test.mo test/memory_migration.test.mo test/requirements.test.mo test/principal_text.test.mo test/designs.test.mo test/holdings.test.mo test/directory.test.mo test/wire.test.mo test/wire_fixtures.test.mo test/trades.test.mo test/main.test.mo test/contacts_integrity.test.mo",
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:motoko`
Expected: FAIL — `v9` and `v8_to_v9` do not resolve.

- [ ] **Step 4: Write `backend/memory/chipswap/v9.mo`**

Copy `v8.mo` verbatim, then make exactly three changes: replace the header comment, replace `OutgoingState`, and add the history types plus the two new `Mem` fields. The full new and changed parts:

```motoko
// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
//
// V9 gives a finished trade somewhere to live.
//
// Until now the two directions ended differently for reasons that were about
// the code and not about the owner. An outgoing trade stayed in `outgoing`
// carrying a terminal state, because that row doubled as the retry handle for
// an unconfirmed outcome. An incoming trade was deleted the moment delivery
// succeeded, because delivery had a tidy single place to delete it from. So the
// app could show an offer made weeks ago that was never cleared, and could not
// show the trade accepted an hour ago.
//
// `history` is the record both directions now write. `incoming` and `outgoing`
// become tables of work in progress and nothing else, which is also why
// `OutgoingState` loses `#completed`, `#declined` and `#failed`: a settled row
// is not stored there any more, and a variant no stored row can hold is an
// invitation to write handling for a case that cannot arrive.
//
// What an entry stores is names, not pictures. A chip's art is about a kilobyte
// and it already has an owner elsewhere; a ledger row says what moved and when,
// and the page draws the art from the real thing wherever it still exists.
```

The changed state type:

```motoko
    public type OutgoingState = {
        #sending;
        #pending_designer;
        #uncertain;
    };
```

The new types, placed after `OutgoingTrade` and before `ReplayOutcome`:

```motoko
    public type HistoryDirection = { #outgoing; #incoming };

    // One side's chip, named rather than copied.
    public type HistoryChip = { title : Text; ref : ChipRef };

    // `ours` and `theirs` are sides of the swap, not directions of travel, and
    // the outcome says whether the chips actually moved. Naming them for travel
    // would empty both fields on exactly the rows this record exists for: an
    // offer we declined moved nothing, and the row still has to name the chip
    // that was turned down.
    public type HistoryOutcome = {
        #traded;
        #declined_by_peer : Text;
        #declined_by_owner;
        #failed : Text;
        #unresolved;
    };

    // `escrow_key` is `OutgoingTrade.offered_key` carried across: null when the
    // offer was minted from one of our own designs and so cost us nothing.
    // Resolving an `#unresolved` entry later has to release or consume the chip
    // that is still escrowed, and this is how it finds it.
    public type HistoryEntry = {
        entry_id : Nat;
        direction : HistoryDirection;
        peer : Principal;
        request_id : Blob;
        want_design_id : Nat;
        ours : ?HistoryChip;
        theirs : ?HistoryChip;
        escrow_key : ?Text;
        outcome : HistoryOutcome;
        started_at_ns : Int;
        settled_at_ns : Int;
    };
```

`Mem` gains two fields (keep every existing field exactly as it is):

```motoko
    public type Mem = {
        var revision : Nat;
        var next_request_seq : Nat;
        var next_brush_id : Nat;
        var next_history_id : Nat;
        designs : Map.Map<Nat, Design>;
        holdings : Map.Map<Text, Chip>;
        directory : Map.Map<Principal, DirectoryEntry>;
        incoming : Map.Map<Text, IncomingTrade>;
        outgoing : Map.Map<Text, OutgoingTrade>;
        replay : Map.Map<Text, ReplayRecord>;
        history : Map.Map<Nat, HistoryEntry>;
        brushes : List.List<CustomBrush>;
    };
```

and `init()` gains the matching two lines:

```motoko
            var next_history_id = 1;
            history = Map.empty<Nat, HistoryEntry>();
```

- [ ] **Step 5: Write `backend/memory/chipswap/v8_to_v9.mo`**

```motoko
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
        // The request id breaks ties, because two trades proposed in the same
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:motoko`
Expected: PASS, including every pre-existing Motoko test.

- [ ] **Step 7: Commit**

```bash
git add backend/memory/chipswap/v9.mo backend/memory/chipswap/v8_to_v9.mo test/memory_v9.test.mo package.json
git commit -m "feat: memory v9 gives a settled trade somewhere to live

Terminal outgoing rows migrate into the new history root instead of
sitting in the live table; the inbound side starts empty because those
rows were deleted at delivery and cannot be reconstructed honestly."
```

---

### Task 2: History primitives and the outgoing funnel in `Trades.mo`

**Files:**
- Modify: `backend/Trades.mo` (import, new section, nine transition sites)
- Modify: `backend/Designs.mo`, `backend/Directory.mo`, `backend/Holdings.mo`, `backend/Requirements.mo`, `backend/main.mo` (import line only, plus `main.mo` compile fixes)
- Modify: `test/contacts_integrity.test.mo`, `test/designs.test.mo`, `test/directory.test.mo`, `test/holdings.test.mo`, `test/main.test.mo`, `test/requirements.test.mo`, `test/trades.test.mo` (import line only)
- Create: `test/trade_history.test.mo`
- Modify: `package.json` (the `test:motoko` script)

**Interfaces:**
- Consumes: `V9.HistoryEntry`, `V9.HistoryChip`, `V9.HistoryOutcome`, `V9.HistoryDirection`, `V9.OutgoingState` from Task 1.
- Produces, all on `Trades`:
  - `MAX_HISTORY : Nat`
  - `recordHistory(mem, direction, peer, requestId, wantDesignId, ours : ?Memory.HistoryChip, theirs : ?Memory.HistoryChip, escrowKey : ?Text, outcome, startedAt : Int, now : Int) : Nat`
  - `historyPage(mem, offset : Nat, limit : Nat) : { entries : [Memory.HistoryEntry]; total : Nat }`
  - `forgetHistory(mem, entryId : Nat) : Result<()>`
  - `clearHistory(mem) : Nat`
  - `findUnresolved(mem, requestId : Blob) : ?Memory.HistoryEntry`
  - `abandonOutgoing(mem, requestId : Blob, now : Int) : Result<()>`
  - `resolveUnresolved(mem, requestId : Blob, reply : ?Wire.StatusReply, now : Int) : Result<Text>`
  - `completeDelivery(mem, requestId : Blob, self : Principal, now : Int) : Result<()>` — **signature changed**, two new parameters.

The import swap is one atomic edit: `OutgoingState` loses variants, so nothing compiles until every consumer is updated together.

- [ ] **Step 1: Write the failing test**

Create `test/trade_history.test.mo`. This is a script, like `test/trades.test.mo`:

```motoko
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Designs "../backend/Designs";
import Holdings "../backend/Holdings";
import Memory "../backend/memory/chipswap/v9";
import Shape "../backend/Shape";
import Trades "../backend/Trades";
import Wire "../backend/Wire";

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

// A canister with one published design to offer.
func freshMem() : Memory.Mem {
    let mem = Memory.init();
    let designId = switch (Designs.create(mem, "Ours", 0)) {
        case (#ok(id)) id;
        case (#err(code)) Runtime.trap("could not create a design: " # code);
    };
    switch (Designs.publish(mem, designId, { shape_id = Shape.SHAPE_ID; palette = art.palette; pixels = art.pixels }, 0)) {
        case (#ok(_)) {};
        case (#err(code)) Runtime.trap("could not publish: " # code);
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
    let mem = freshMem();
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
    let mem = freshMem();
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
    let mem = freshMem();
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
    let found = Trades.findUnresolved(mem, proposal.request_id);
    if (found == null) Runtime.trap("an unresolved entry cannot be found again");
};

// --- A declined inbound offer names the chip we turned down ---------------

do {
    let mem = freshMem();
    // Manual approval is what puts an offer in the incoming table.
    let ?design = Designs.get(mem, 1) else Runtime.trap("missing design");
    Designs.setRequirements(mem, 1, { design.requirements with approval = true }, 0);

    let id = requestId(9);
    ignore Trades.acceptInbound(
        mem,
        { request_id = id; want_design_id = 1; offered = peerChip(11) },
        bob,
        alice,
        100,
    );
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
    let oldest = page.entries[page.entries.size() - 1];
    if (oldest.started_at_ns != 5) Runtime.trap("eviction did not drop the oldest");
};

// --- Forgetting: one at a time, and a bulk clear that spares the unresolved -

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
    let another = Trades.recordHistory(mem, #outgoing, bob, requestId(3), 1, null, null, null, #traded, 30, 30);
    if (Trades.clearHistory(mem) != 1) Runtime.trap("clear removed the wrong number");
    let left = Trades.historyPage(mem, 0, 100);
    if (left.total != 1) Runtime.trap("clear did not leave the unresolved entry");
    if (left.entries[0].entry_id != stuck) Runtime.trap("clear kept the wrong entry");
    ignore another;

    // Individually, it can still go.
    ignore expectOk(Trades.forgetHistory(mem, stuck));
    if (Trades.historyPage(mem, 0, 100).total != 0) Runtime.trap("an unresolved entry could not be forgotten");
};
```

> Note on `freshMem`: check the real signatures of `Designs.create`, `Designs.publish` and `Designs.setRequirements` in `backend/Designs.mo` before running, and adjust the three calls to match. The behaviour under test is the history, not the design API.

- [ ] **Step 2: Register the test**

Add `test/trade_history.test.mo` to the `test:motoko` script in `package.json`, right after `test/trades.test.mo`.

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test:motoko`
Expected: FAIL — `Trades.historyPage` and friends do not exist, and `v9` is not what `Trades` imports.

- [ ] **Step 4: Swap every import from v8 to v9**

Ten files change one line each. In `backend/Designs.mo`, `backend/Directory.mo`, `backend/Holdings.mo`, `backend/Requirements.mo`, `backend/Trades.mo`, `backend/main.mo`, and in `test/contacts_integrity.test.mo`, `test/designs.test.mo`, `test/directory.test.mo`, `test/holdings.test.mo`, `test/main.test.mo`, `test/requirements.test.mo`, `test/trades.test.mo`:

```motoko
import Memory "./memory/chipswap/v9";        // backend files
import Memory "../backend/memory/chipswap/v9"; // test files
```

Do **not** touch `test/memory_v8.test.mo` (v8 is its subject) or `test/memory_migration.test.mo` yet — that one gets its v9 leg in Task 3.

```bash
# from apps/chipswap/
sed -i 's|memory/chipswap/v8"|memory/chipswap/v9"|' \
  backend/Designs.mo backend/Directory.mo backend/Holdings.mo \
  backend/Requirements.mo backend/Trades.mo backend/main.mo \
  test/contacts_integrity.test.mo test/designs.test.mo test/directory.test.mo \
  test/holdings.test.mo test/main.test.mo test/requirements.test.mo test/trades.test.mo
```

- [ ] **Step 5: Add the history section to `Trades.mo`**

Add `MAX_HISTORY` beside the other caps at the top:

```motoko
    public let MAX_HISTORY : Nat = 256;
```

Add a new public section, placed after `pendingOutgoing` and before `getOutgoing`:

```motoko
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

    // Ids ascend with time, so the newest entry is the largest id. The sort is
    // explicit rather than leaning on the map's iteration order, which is how
    // `Holdings.page` does it too.
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
    // retrying a delivery we have already dealt with must be told so, or it
    // retries forever.
    public func settledOutgoing(mem : Memory.Mem, requestId : Blob, peer : Principal) : Bool {
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

    func ourSide(trade : Memory.OutgoingTrade) : ?Memory.HistoryChip {
        ?{ title = trade.offered_title; ref = trade.offered_ref };
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
            ourSide(trade),
            theirs,
            trade.offered_key,
            outcome,
            trade.created_at_ns,
            now,
        );
    };
```

Make sure `Nat` is imported in `Trades.mo` — it already is.

- [ ] **Step 6: Route every terminal transition through the funnel**

In `Trades.mo`, replace each `setOutgoing(...)` call that sets a terminal state. The three live states keep using `setOutgoing`.

`finishPropose`, the `#declined` arm:

```motoko
            case (#declined(payload)) {
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #declined_by_peer(bounded(payload.reason)), now);
                #ok("declined");
            };
```

`finishPropose`, the `#err` arm:

```motoko
            case (#err(payload)) {
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #failed(bounded(payload.code)), now);
                #ok("failed");
            };
```

`deliverInbound`, the `#returned` arm:

```motoko
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #declined_by_peer("returned"), now);
                #ok("returned");
```

`deliverInbound`, the `#declined` arm:

```motoko
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #declined_by_peer("designer_declined"), now);
                #ok("declined");
```

`resolveOutgoing`, the `#unknown` arm:

```motoko
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #failed("not_received"), now);
                #ok("not_received");
```

`resolveOutgoing`, the `#declined` arm:

```motoko
                restoreOffer(mem, trade);
                settleOutgoing(mem, key, trade, null, #declined_by_peer(bounded(payload.reason)), now);
                #ok("declined");
```

`completeWithChip`, both arms — note `theirs` is known here, so the record names the chip:

```motoko
        let received = chipFromWire(chip, now);
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
```

- [ ] **Step 7: Keep repeat calls idempotent now that the row is gone**

In `deliverInbound`, the lookup and the state switch both change. Replace the opening of the function:

```motoko
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
```

In `resolveOutgoing`, the state switch loses its catch-all because only three variants remain:

```motoko
        switch (trade.state) {
            case (#uncertain) {};
            case (#pending_designer) {};
            case (#sending) return #err("not_resolvable");
        };
```

- [ ] **Step 8: Add abandon and resolve-from-history**

Append to the history section of `Trades.mo`:

```motoko
    // Setting aside a trade whose outcome was never confirmed. It frees the
    // slot and records what is known, which is nothing new — so the chip is not
    // touched. Releasing it here would duplicate a unique chip into the world
    // every time the guess was wrong, and there is no way to notice afterwards.
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
                // record means the offer was never admitted.
                releaseEscrow(mem, entry);
                rewrite(mem, entry, null, #failed("not_received"), now);
                #ok("not_received");
            };
            case (#declined(payload)) {
                releaseEscrow(mem, entry);
                rewrite(mem, entry, null, #declined_by_peer(bounded(payload.reason)), now);
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
                        rewrite(mem, entry, theirs, #failed(code), now);
                        return #err(code);
                    };
                    case (#ok(())) {};
                };
                rewrite(mem, entry, theirs, #traded, now);
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

    func rewrite(
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
```

- [ ] **Step 9: Record the inbound side in `completeDelivery`**

Replace `completeDelivery` in `Trades.mo`:

```motoko
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
            // names the chip, because that is the whole content of it.
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
```

- [ ] **Step 10: Make `main.mo` compile again**

Two call sites break. At `backend/main.mo:1202`, pass the two new arguments:

```motoko
            if (delivered) ignore Trades.completeDelivery(mem, delivery.request_id, self, Time.now());
```

And `outgoingStateText` now covers three variants:

```motoko
    func outgoingStateText(state : Memory.OutgoingState) : (Text, ?Text) {
        switch (state) {
            case (#sending) ("sending", null);
            case (#pending_designer) ("pending_designer", null);
            case (#uncertain) ("uncertain", null);
        };
    };
```

`chipswap_trade_forget` still calls `Trades.forgetOutgoing`, which no longer has any terminal state to accept — leave both in place for now; Task 3 removes them together.

- [ ] **Step 11: Run the tests**

Run: `npm run test:motoko`
Expected: PASS. Existing assertions in `test/trades.test.mo` that read a terminal state off `mem.outgoing` will fail — update them to read `Trades.historyPage(mem, 0, 100)` instead. That is the behaviour change under test, not a broken test.

- [ ] **Step 12: Commit**

```bash
git add backend test package.json
git commit -m "feat: settled trades leave the live tables for a history record

Every terminal outgoing transition funnels through settleOutgoing, which
removes the row and writes the record as one act; the inbound side writes
its record where completeDelivery already deleted the row. A repeat
delivery for a settled trade is answered from history, so a retrying peer
still stops."
```

---

### Task 3: Endpoints, manifest, and the migration chain test

**Files:**
- Modify: `backend/main.mo` (view types, four endpoints, resolve, error messages, retire forget)
- Modify: `backend/Trades.mo` (delete `forgetOutgoing`)
- Modify: `neutron.json` (memory block, `func`, `preapproved_self_calls`, `version`)
- Modify: `test/package.test.ts` (version and memory expectations)
- Modify: `test/memory_migration.test.mo` (add the v8 → v9 leg)
- Modify: `test/main.test.mo` (endpoint coverage)

**Interfaces:**
- Consumes: every `Trades` function produced by Task 2.
- Produces, for the frontend: `chipswap_trade_history(PageRequest) : TradeHistoryPage`, `chipswap_history_forget(HistoryEntryRef) : RevisionResult`, `chipswap_history_clear(()) : RevisionResult`, `chipswap_trade_abandon(TradeRequestRef) : RevisionResult`. `chipswap_trade_forget` is gone. `TradeHistoryView` field names are the JSON keys `api.ts` parses in Task 4.

- [ ] **Step 1: Write the failing endpoint test**

Append to `test/main.test.mo`, following the style already there (the file walks one canister through a sequence of calls). Add after the existing trade coverage:

```motoko
// --- The record a finished trade leaves ----------------------------------

// A trade that settles is not in the live list any more; it is in the ledger,
// and the ledger is what the owner reads.
let historyPage = app.chipswap_trade_history({ offset = 0; limit = 20 });
if (historyPage.total == 0) Runtime.trap("a settled trade left no record");
let record = historyPage.entries[0];
if (record.direction != "outgoing" and record.direction != "incoming") {
    Runtime.trap("a record does not say which way the trade went");
};
if (record.entry_id == 0) Runtime.trap("a record has no id");

// Forgetting one is the owner's call and takes effect immediately.
switch (app.chipswap_history_forget({ entry_id = record.entry_id })) {
    case (#ok(_)) {};
    case (#err(err)) Runtime.trap("forgetting a record failed: " # err.code);
};
if (app.chipswap_trade_history({ offset = 0; limit = 20 }).total != historyPage.total - 1) {
    Runtime.trap("forgetting a record did not remove it");
};

// A record that never existed is named as such rather than silently accepted.
switch (app.chipswap_history_forget({ entry_id = 99_999 })) {
    case (#ok(_)) Runtime.trap("forgetting a missing record should fail");
    case (#err(err)) if (err.code != "unknown_entry") Runtime.trap("wrong code: " # err.code);
};

// Only a trade with an unconfirmed outcome can be set aside.
switch (app.chipswap_trade_abandon({ request_id = "00" })) {
    case (#ok(_)) Runtime.trap("abandoning an unknown trade should fail");
    case (#err(err)) if (err.code != "unknown_trade") Runtime.trap("wrong code: " # err.code);
};
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:motoko`
Expected: FAIL — those four methods do not exist on the service.

- [ ] **Step 3: Add the view types to `main.mo`**

Beside `OutgoingTradeView`:

```motoko
    public type HistoryChipView = {
        title : Text;
        designer : Text;
        design_id : Nat;
        serial : Nat;
    };

    // `ours` and `theirs` are the two sides of the swap. Either may be absent:
    // a peer who declined never minted, and an offer we refused was never
    // matched. `outcome` is what says whether the chips actually moved.
    public type TradeHistoryView = {
        entry_id : Nat;
        direction : Text;
        peer : Text;
        request_id : Text;
        want_design_id : Nat;
        ours : ?HistoryChipView;
        theirs : ?HistoryChipView;
        outcome : Text;
        detail : ?Text;
        started_at_ns : Int;
        settled_at_ns : Int;
        contact_name : ?Text;
    };

    public type TradeHistoryPage = {
        entries : [TradeHistoryView];
        total : Nat;
    };
```

Beside `TradeRequestRef`:

```motoko
    public type HistoryEntryRef = { entry_id : Nat };
```

- [ ] **Step 4: Add the endpoints**

Inside the class, after `chipswap_trades`:

```motoko
        // Kept out of `chipswap_trades` on purpose: that call is polled for the
        // pending badge, and the ledger has no business riding along with it.
        public func /*query*/chipswap_trade_history(request : PageRequest) : TradeHistoryPage {
            let page = Trades.historyPage(mem, request.offset, boundedLimit(request.limit));
            {
                entries = Array.map<Memory.HistoryEntry, TradeHistoryView>(
                    page.entries,
                    func(entry) {
                        let (outcome, detail) = historyOutcomeText(entry.outcome);
                        {
                            entry_id = entry.entry_id;
                            direction = switch (entry.direction) {
                                case (#outgoing) "outgoing";
                                case (#incoming) "incoming";
                            };
                            peer = Principal.toText(entry.peer);
                            request_id = Trades.hex(entry.request_id);
                            want_design_id = entry.want_design_id;
                            ours = historyChipView(entry.ours);
                            theirs = historyChipView(entry.theirs);
                            outcome;
                            detail;
                            started_at_ns = entry.started_at_ns;
                            settled_at_ns = entry.settled_at_ns;
                            contact_name = contactName(entry.peer);
                        };
                    },
                );
                total = page.total;
            };
        };

        public func /*update*/chipswap_history_forget(
            request : HistoryEntryRef
        ) : RevisionResult {
            switch (Trades.forgetHistory(mem, request.entry_id)) {
                case (#err(code)) #err(error(code));
                case (#ok(())) {
                    bump();
                    #ok({ revision = mem.revision });
                };
            };
        };

        public func /*update*/chipswap_history_clear(()) : RevisionResult {
            ignore Trades.clearHistory(mem);
            bump();
            #ok({ revision = mem.revision });
        };

        // Frees the slot a trade with an unconfirmed outcome is holding. It
        // decides nothing: the chip stays escrowed and the record says so.
        public func /*update*/chipswap_trade_abandon(
            request : TradeRequestRef
        ) : RevisionResult {
            let ?requestId = Trades.unhex(request.request_id) else return #err(error("invalid_request"));
            switch (Trades.abandonOutgoing(mem, requestId, Time.now())) {
                case (#err(code)) #err(error(code));
                case (#ok(())) {
                    bump();
                    #ok({ revision = mem.revision });
                };
            };
        };
```

Add the two helpers beside `outgoingStateText`:

```motoko
    func historyOutcomeText(outcome : Memory.HistoryOutcome) : (Text, ?Text) {
        switch (outcome) {
            case (#traded) ("traded", null);
            case (#declined_by_peer(reason)) ("declined_by_peer", ?reason);
            case (#declined_by_owner) ("declined_by_owner", null);
            case (#failed(code)) ("failed", ?code);
            case (#unresolved) ("unresolved", null);
        };
    };
```

and, inside the class next to `chipView` (it needs nothing from the class, but keep it near its only caller):

```motoko
        func historyChipView(chip : ?Memory.HistoryChip) : ?HistoryChipView {
            switch (chip) {
                case (?value) ?{
                    title = value.title;
                    designer = Principal.toText(value.ref.designer);
                    design_id = value.ref.design_id;
                    serial = value.ref.serial;
                };
                case null null;
            };
        };
```

- [ ] **Step 5: Teach resolve to answer from history**

Replace the body of `chipswap_trade_resolve` so it falls back when there is no live row. The peer and status call are the same either way:

```motoko
        public func /*update*/chipswap_trade_resolve(
            request : TradeRequestRef
        ) : async* TradeActionResult {
            let ?requestId = Trades.unhex(request.request_id) else return #err(error("invalid_request"));
            // A trade the owner set aside is still answerable: the entry keeps
            // the peer and the request id precisely so it can be asked again.
            let (peer, fromHistory) = switch (Trades.getOutgoing(mem, requestId)) {
                case (?trade) (trade.peer, false);
                case null {
                    let ?entry = Trades.findUnresolved(mem, requestId) else {
                        return #err(error("unknown_trade"));
                    };
                    (entry.peer, true);
                };
            };
            let payload : PeerStatusRequest = { request_id = requestId };
            let reply = await* callRoute(
                peer,
                ROUTE_STATUS,
                to_candid (payload),
                STATUS_CYCLES,
                16_384,
            );
            let answer = switch (reply) {
                case null null;
                case (?bytes) Wire.decodeStatusReply(bytes);
            };
            let settled = if (fromHistory) {
                Trades.resolveUnresolved(mem, requestId, answer, Time.now());
            } else {
                Trades.resolveOutgoing(mem, requestId, answer, Time.now());
            };
            switch (settled) {
                case (#err(code)) {
                    bump();
                    #err(error(code));
                };
                case (#ok(outcome)) {
                    bump();
                    #ok({
                        request_id = request.request_id;
                        outcome;
                        revision = mem.revision;
                    });
                };
            };
        };
```

- [ ] **Step 6: Retire `chipswap_trade_forget`**

Delete the `chipswap_trade_forget` function from `backend/main.mo` and `forgetOutgoing` from `backend/Trades.mo`. Delete the `"not_final"` case from `messageFor` — nothing produces that code any more — and add the two new ones:

```motoko
            case ("unknown_entry") "That record is no longer here.";
            case ("not_uncertain") "Only a trade with an unconfirmed outcome can be set aside.";
```

- [ ] **Step 7: Regenerate the method schema block**

The `/*---NEUTRON GENERATED BEGIN---*/` section at the foot of `main.mo` is produced by the generator, not by hand.

Run: `npm run mogen`
Expected: the generated block gains `chipswap_trade_history_Input/Output`, `chipswap_history_forget_*`, `chipswap_history_clear_*`, `chipswap_trade_abandon_*`, and loses `chipswap_trade_forget_*`.

- [ ] **Step 8: Update `neutron.json`**

Four edits:

1. `"version": 120` becomes `"version": 121`.
2. In `capabilities.preapproved_self_calls.methods`, remove `"chipswap_trade_forget"` and add `"chipswap_trade_history"`, `"chipswap_history_forget"`, `"chipswap_history_clear"`, `"chipswap_trade_abandon"`.
3. In `func`, remove the `chipswap_trade_forget` entry and add:

```json
    "chipswap_trade_history": {
      "type": "query",
      "async": false
    },
    "chipswap_history_forget": {
      "type": "update",
      "async": false
    },
    "chipswap_history_clear": {
      "type": "update",
      "async": false
    },
    "chipswap_trade_abandon": {
      "type": "update",
      "async": false
    },
```

4. In `memory.chipswap`, set `"version": 9`, add `"9": { "src": "memory/chipswap/v9.mo" }` to `schemas`, and append to `migrations`:

```json
        {
          "from": 8,
          "to": 9,
          "src": "memory/chipswap/v8_to_v9.mo"
        }
```

- [ ] **Step 9: Update `test/package.test.ts`**

Change `version: 120` to `version: 121`, `version: 8` to `version: 9` in the memory block, add `9: { src: "memory/chipswap/v9.mo" }` to the schemas object, and add `{ from: 8, to: 9, src: "memory/chipswap/v8_to_v9.mo" }` to the migrations array. These are exact-value assertions; the surrounding consistency tests need no change.

- [ ] **Step 10: Add the v8 → v9 leg to the chain test**

`test/memory_migration.test.mo` walks every released version in order. Add an import at the top:

```motoko
import V9 "../backend/memory/chipswap/v9";
import Migrate9 "../backend/memory/chipswap/v8_to_v9";
```

and a section at the foot, matching the style of the `V7 -> V8` block above it:

```motoko
// --- V8 -> V9 -----------------------------------------------------------

// The ninth conversion moves settled trades out of the live table. The row this
// fixture has been carrying since the start is still in flight, so it stays put
// and the ledger stays empty — which is the case worth pinning, because a
// migration that swept live work into history would lose the owner's trade.
let v9 : V9.Mem = Migrate9.migrate(v8);

assert (v9.revision == v8.revision);
assert (v9.next_request_seq == v8.next_request_seq);
assert (v9.next_brush_id == v8.next_brush_id);
assert (Map.size(v9.directory) == Map.size(v8.directory));
assert (Map.size(v9.designs) == Map.size(v8.designs));
assert (Map.size(v9.holdings) == Map.size(v8.holdings));
assert (Map.size(v9.incoming) == Map.size(v8.incoming));
assert (Map.size(v9.outgoing) == Map.size(v8.outgoing));
assert (Map.size(v9.replay) == Map.size(v8.replay));
assert (v9.next_history_id == 1);

let ?carried9 = Map.get(v9.directory, Principal.compare, peer) else Runtime.trap("missing entry");
assert (carried9.ignored);

let ?draft9 = Map.get(v9.designs, Nat.compare, 3) else Runtime.trap("missing design");
assert (draft9.state == #draft);

let ?sent9 = Map.get(v9.holdings, Text.compare, "sent") else Runtime.trap("missing chip");
ignore sent9;

let ?brush9 = List.get(v9.brushes, 0) else Runtime.trap("missing brush");
ignore brush9;
```

> If the fixture's outgoing row is in a terminal state rather than a live one, invert the two size assertions: `Map.size(v9.outgoing) == 0` and `Map.size(v9.history) == 1`. Read the fixture at the `V7 -> V8` block before writing this.

- [ ] **Step 11: Run everything**

Run: `npm run test:motoko && bun test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add backend neutron.json test
git commit -m "feat: endpoints for the trade ledger, and a manifest at memory v9

chipswap_trade_history pages the record, forget and clear prune it, and
abandon frees the slot a trade with an unconfirmed outcome is holding.
Resolve now answers from history too, so a trade set aside can still be
asked about. chipswap_trade_forget retires with the rows it cleared."
```

---

### Task 4: The client API

**Files:**
- Modify: `src/api.ts`
- Modify: `test/api.test.ts`

**Interfaces:**
- Consumes: the JSON shapes produced by Task 3's `TradeHistoryView` and `TradeHistoryPage`.
- Produces: `TradeHistoryEntry`, `HistoryChip`, `parseTradeHistoryEntry`, `loadTradeHistory(offset, limit)`, `forgetHistoryEntry(entryId)`, `clearTradeHistory()`, `abandonTrade(requestId)`, and an `OutgoingTrade["state"]` union narrowed to three values. `forgetTrade` is gone.

- [ ] **Step 1: Write the failing parser test**

Append to `test/api.test.ts`, matching the style of the parser tests already there:

```ts
test("a history entry parses both sides of a trade", () => {
  const entry = parseTradeHistoryEntry({
    entry_id: 4,
    direction: "outgoing",
    peer: "aaaaa-aa",
    request_id: "ab12",
    want_design_id: 3,
    ours: { title: "Bluebird", designer: "aaaaa-aa", design_id: 1, serial: 2 },
    theirs: { title: "Ember", designer: "aaaaa-aa", design_id: 3, serial: 9 },
    outcome: "traded",
    detail: null,
    started_at_ns: "100",
    settled_at_ns: "200",
    contact_name: "Rae",
  });

  expect(entry.entryId).toBe(4);
  expect(entry.outcome).toBe("traded");
  expect(entry.ours?.title).toBe("Bluebird");
  expect(entry.theirs?.serial).toBe(9);
  expect(entry.contactName).toBe("Rae");
});

// A refusal is the row the ledger exists for, and it has only one side.
test("a declined offer parses with no chip on our side", () => {
  const entry = parseTradeHistoryEntry({
    entry_id: 5,
    direction: "incoming",
    peer: "aaaaa-aa",
    request_id: "cd34",
    want_design_id: 2,
    ours: null,
    theirs: { title: "Ochre", designer: "aaaaa-aa", design_id: 2, serial: 4 },
    outcome: "declined_by_owner",
    detail: null,
    started_at_ns: "10",
    settled_at_ns: "20",
    contact_name: null,
  });

  expect(entry.ours).toBeNull();
  expect(entry.theirs?.title).toBe("Ochre");
  expect(entry.outcome).toBe("declined_by_owner");
});

test("a peer's reason survives on a declined outgoing trade", () => {
  const entry = parseTradeHistoryEntry({
    entry_id: 6,
    direction: "outgoing",
    peer: "aaaaa-aa",
    request_id: "ef56",
    want_design_id: 1,
    ours: { title: "Ash", designer: "aaaaa-aa", design_id: 1, serial: 1 },
    theirs: null,
    outcome: "declined_by_peer",
    detail: "min_colors",
    started_at_ns: "1",
    settled_at_ns: "2",
    contact_name: null,
  });

  expect(entry.detail).toBe("min_colors");
  expect(entry.theirs).toBeNull();
});
```

Add `parseTradeHistoryEntry` to the import list at the top of `test/api.test.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/api.test.ts`
Expected: FAIL — `parseTradeHistoryEntry` is not exported.

- [ ] **Step 3: Add the types and parser to `src/api.ts`**

Beside `OutgoingTrade`, and narrow that type's `state` while you are there:

```ts
export type OutgoingTrade = {
  requestId: string;
  peer: string;
  wantDesignId: number;
  offeredDesigner: string;
  offeredDesignId: number;
  offeredSerial: number;
  offeredTitle: string;
  offeredKey: string | null;
  state: "sending" | "pending_designer" | "uncertain";
  detail: string | null;
  createdAtNs: string;
  updatedAtNs: string;
  contactName: string | null;
};

export type HistoryChip = {
  title: string;
  designer: string;
  designId: number;
  serial: number;
};

export type TradeHistoryEntry = {
  entryId: number;
  direction: "outgoing" | "incoming";
  peer: string;
  requestId: string;
  wantDesignId: number;
  ours: HistoryChip | null;
  theirs: HistoryChip | null;
  outcome:
    | "traded"
    | "declined_by_peer"
    | "declined_by_owner"
    | "failed"
    | "unresolved";
  detail: string | null;
  startedAtNs: string;
  settledAtNs: string;
  contactName: string | null;
};
```

In `parseOutgoingTrade`, shrink the `oneOf` list to `["sending", "pending_designer", "uncertain"] as const`.

Add the parser beside `parseOutgoingTrade`:

```ts
function parseHistoryChip(value: unknown, label: string): HistoryChip | null {
  if (value === null || value === undefined) return null;
  const source = record(value, label);
  return {
    title: text(source.title, "chip title"),
    designer: text(source.designer, "chip designer"),
    designId: natNumber(source.design_id, "chip design id"),
    serial: natNumber(source.serial, "chip serial"),
  };
}

export function parseTradeHistoryEntry(value: unknown): TradeHistoryEntry {
  const source = record(value, "history entry");
  return {
    entryId: natNumber(source.entry_id, "entry id"),
    direction: oneOf(source.direction, ["outgoing", "incoming"] as const, "direction"),
    peer: text(source.peer, "peer"),
    requestId: text(source.request_id, "request id"),
    wantDesignId: natNumber(source.want_design_id, "design id"),
    ours: parseHistoryChip(source.ours, "our chip"),
    theirs: parseHistoryChip(source.theirs, "their chip"),
    outcome: oneOf(
      source.outcome,
      [
        "traded",
        "declined_by_peer",
        "declined_by_owner",
        "failed",
        "unresolved",
      ] as const,
      "outcome",
    ),
    detail: optionalText(source.detail, "detail"),
    startedAtNs: nsText(source.started_at_ns, "start time"),
    settledAtNs: nsText(source.settled_at_ns, "settle time"),
    contactName: optionalText(source.contact_name, "contact name"),
  };
}
```

- [ ] **Step 4: Add the calls**

Beside `loadDirectory`, following its exact shape:

```ts
export async function loadTradeHistory(
  offset: number,
  limit: number,
): Promise<{ entries: TradeHistoryEntry[]; total: number }> {
  const value = record(
    await querySelf("chipswap_trade_history", [
      { offset: String(offset), limit: String(limit) },
    ] as unknown as JsonValue[]),
    "trade history",
  );
  return {
    entries: list(value.entries, "history list").map(parseTradeHistoryEntry),
    total: natNumber(value.total, "total"),
  };
}
```

Replace `forgetTrade` with these three:

```ts
export async function forgetHistoryEntry(entryId: number): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_history_forget", [
      { entry_id: String(entryId) },
    ] as unknown as JsonValue[]),
  );
}

export async function clearTradeHistory(): Promise<number> {
  return parseRevision(await updateSelf("chipswap_history_clear", NO_ARGUMENT));
}

export async function abandonTrade(requestId: string): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_trade_abandon", [
      { request_id: requestId },
    ] as unknown as JsonValue[]),
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/api.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/api.ts test/api.test.ts
git commit -m "feat: client types and calls for the trade ledger

An entry names both sides of a swap and either may be absent, so the
parser reads ours and theirs independently rather than assuming a
completed trade."
```

---

### Task 5: The Trades page

**Files:**
- Modify: `src/views/trades.tsx`
- Create: `test/trades_history_panel.test.tsx`
- Modify: `src/style.scss` if the table needs anything beyond the existing `nt-` classes

**Interfaces:**
- Consumes: everything Task 4 exported.
- Produces: no exports other than the existing `Trades` component.

- [ ] **Step 1: Write the failing component test**

Create `test/trades_history_panel.test.tsx`, modelled on `test/chip_save_panel.test.tsx` (read it first for the render helper and mocking style this repo uses):

```tsx
import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { HistoryPanel } from "../src/views/trades.tsx";
import type { TradeHistoryEntry } from "../src/api.ts";

function entry(overrides: Partial<TradeHistoryEntry> = {}): TradeHistoryEntry {
  return {
    entryId: 1,
    direction: "outgoing",
    peer: "aaaaa-aa",
    requestId: "ab12",
    wantDesignId: 1,
    ours: { title: "Bluebird", designer: "aaaaa-aa", designId: 1, serial: 2 },
    theirs: { title: "Ember", designer: "aaaaa-aa", designId: 3, serial: 9 },
    outcome: "traded",
    detail: null,
    startedAtNs: "100",
    settledAtNs: "200",
    contactName: null,
    ...overrides,
  };
}

test("a completed trade shows both chips", () => {
  render(
    <HistoryPanel
      entries={[entry()]}
      total={1}
      busy={null}
      onForget={() => {}}
      onClear={() => {}}
      onAskAgain={() => {}}
      onShowMore={() => {}}
    />,
  );
  expect(screen.getByText("Bluebird")).toBeTruthy();
  expect(screen.getByText("Ember")).toBeTruthy();
});

// The row this panel exists for: an offer we turned down still names the chip.
test("a declined offer names the chip we turned down", () => {
  render(
    <HistoryPanel
      entries={[entry({ direction: "incoming", ours: null, outcome: "declined_by_owner" })]}
      total={1}
      busy={null}
      onForget={() => {}}
      onClear={() => {}}
      onAskAgain={() => {}}
      onShowMore={() => {}}
    />,
  );
  expect(screen.getByText("Ember")).toBeTruthy();
  expect(screen.getByText("You declined")).toBeTruthy();
});

// Asking again is offered only where there is something left to ask about.
test("only an unresolved trade offers to ask again", () => {
  const { rerender } = render(
    <HistoryPanel
      entries={[entry()]}
      total={1}
      busy={null}
      onForget={() => {}}
      onClear={() => {}}
      onAskAgain={() => {}}
      onShowMore={() => {}}
    />,
  );
  expect(screen.queryByText("Ask again")).toBeNull();

  rerender(
    <HistoryPanel
      entries={[entry({ outcome: "unresolved", theirs: null })]}
      total={1}
      busy={null}
      onForget={() => {}}
      onClear={() => {}}
      onAskAgain={() => {}}
      onShowMore={() => {}}
    />,
  );
  expect(screen.getByText("Ask again")).toBeTruthy();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/trades_history_panel.test.tsx`
Expected: FAIL — `HistoryPanel` is not exported.

- [ ] **Step 3: Add the panel to `src/views/trades.tsx`**

Update the imports:

```tsx
import {
  abandonTrade,
  acceptTrade,
  clearTradeHistory,
  declineTrade,
  errorMessage,
  forgetHistoryEntry,
  formatTimestamp,
  loadTradeHistory,
  loadTrades,
  resolveTrade,
  shortPrincipal,
  type IncomingTrade,
  type OutgoingTrade,
  type TradeHistoryEntry,
} from "../api.ts";
```

Replace `OUTGOING_LABEL` and add the outcome labels:

```tsx
const OUTGOING_LABEL: Record<OutgoingTrade["state"], string> = {
  sending: "Sending",
  pending_designer: "Waiting for the designer",
  uncertain: "Outcome unknown",
};

const OUTCOME_LABEL: Record<TradeHistoryEntry["outcome"], string> = {
  traded: "Traded",
  declined_by_peer: "They declined",
  declined_by_owner: "You declined",
  failed: "Failed",
  unresolved: "Never confirmed",
};

const HISTORY_PAGE = 25;
```

Add the exported panel above the `Trades` component:

```tsx
type HistoryPanelProps = {
  entries: TradeHistoryEntry[];
  total: number;
  busy: string | null;
  onForget: (entryId: number) => void;
  onClear: () => void;
  onAskAgain: (requestId: string) => void;
  onShowMore: () => void;
};

const chipCell = (chip: TradeHistoryEntry["ours"]) =>
  chip ? <span>{chip.title}</span> : <span className="nt-muted">—</span>;

export const HistoryPanel = ({
  entries,
  total,
  busy,
  onForget,
  onClear,
  onAskAgain,
  onShowMore,
}: HistoryPanelProps) => (
  <div className="nt-panel">
    <header className="nt-section-header">
      <h2 className="nt-section-heading">History</h2>
      <span className="nt-section-count">{total}</span>
      {entries.length > 0 ? (
        <button
          className="nt-button nt-button--ghost nt-button--sm"
          onClick={onClear}
          type="button"
        >
          Forget settled
        </button>
      ) : null}
    </header>

    {entries.length === 0 ? (
      <p className="nt-muted">
        No finished trades yet. Every trade you complete or turn down is
        recorded here.
      </p>
    ) : (
      <>
        <div className="nt-table-wrap">
          <table className="nt-table">
            <thead>
              <tr>
                <th>Settled</th>
                <th>With</th>
                <th>Yours</th>
                <th>Theirs</th>
                <th>Outcome</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.entryId}>
                  <td>{formatTimestamp(entry.settledAtNs)}</td>
                  <td title={entry.peer}>
                    {entry.contactName ?? shortPrincipal(entry.peer)}
                  </td>
                  <td>{chipCell(entry.ours)}</td>
                  <td>{chipCell(entry.theirs)}</td>
                  <td>
                    <span
                      className={cx("nt-tag", {
                        "nt-tag--success": entry.outcome === "traded",
                        "nt-tag--danger": entry.outcome === "failed",
                        "nt-tag--warning": entry.outcome === "unresolved",
                      })}
                    >
                      {OUTCOME_LABEL[entry.outcome]}
                    </span>
                    {entry.detail ? (
                      <span className="nt-meta"> {entry.detail}</span>
                    ) : null}
                  </td>
                  <td>
                    <div className="nt-cluster">
                      {entry.outcome === "unresolved" ? (
                        <button
                          className="nt-button nt-button--sm"
                          disabled={busy === entry.requestId}
                          onClick={() => onAskAgain(entry.requestId)}
                          type="button"
                        >
                          Ask again
                        </button>
                      ) : null}
                      <button
                        className="nt-button nt-button--ghost nt-button--sm"
                        disabled={busy === String(entry.entryId)}
                        onClick={() => onForget(entry.entryId)}
                        type="button"
                      >
                        Forget
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {entries.length < total ? (
          <button
            className="nt-button nt-button--ghost nt-button--sm"
            onClick={onShowMore}
            type="button"
          >
            Show more
          </button>
        ) : null}
      </>
    )}
  </div>
);
```

- [ ] **Step 4: Wire it into the `Trades` component**

Add state and loading beside the existing ones:

```tsx
  const [history, setHistory] = useState<TradeHistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
```

Extend `reload` to fetch both:

```tsx
  const reload = useCallback(async () => {
    try {
      const [trades, ledger] = await Promise.all([
        loadTrades(),
        loadTradeHistory(0, historyLimit),
      ]);
      setIncoming(trades.incoming);
      setOutgoing(trades.outgoing);
      setHistory(ledger.entries);
      setHistoryTotal(ledger.total);
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, [historyLimit]);
```

In the outgoing table, replace the Clear button with Give up. The whole action cell becomes:

```tsx
                    <td>
                      <div className="nt-cluster">
                        <button
                          className="nt-button nt-button--sm"
                          disabled={busy === trade.requestId}
                          onClick={() =>
                            void run(trade.requestId, async () => {
                              const result = await resolveTrade(trade.requestId);
                              return `Designer answered: ${result.outcome}.`;
                            })
                          }
                          type="button"
                        >
                          Ask the designer
                        </button>
                        {trade.state === "uncertain" ? (
                          <button
                            className="nt-button nt-button--ghost nt-button--sm"
                            disabled={busy === trade.requestId}
                            onClick={() =>
                              void run(trade.requestId, async () => {
                                await abandonTrade(trade.requestId);
                                return "Set aside. Your chip stays committed until the designer answers.";
                              })
                            }
                            type="button"
                          >
                            Give up
                          </button>
                        ) : null}
                      </div>
                    </td>
```

Render the panel as the third child of the section:

```tsx
      <HistoryPanel
        entries={history}
        total={historyTotal}
        busy={busy}
        onForget={(entryId) =>
          void run(String(entryId), async () => {
            await forgetHistoryEntry(entryId);
            return "Forgotten.";
          })
        }
        onClear={() =>
          void run("history", async () => {
            await clearTradeHistory();
            return "Settled trades cleared. Anything still unconfirmed stayed.";
          })
        }
        onAskAgain={(requestId) =>
          void run(requestId, async () => {
            const result = await resolveTrade(requestId);
            return `Designer answered: ${result.outcome}.`;
          })
        }
        onShowMore={() => setHistoryLimit((current) => current + HISTORY_PAGE)}
      />
```

- [ ] **Step 5: Run the tests**

Run: `bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/trades.tsx test/trades_history_panel.test.tsx src/style.scss
git commit -m "feat: the Trades page shows what was traded

Your offers holds work in progress only and gains Give up on a trade
whose outcome never came back; History is the record, with Forget on a
row and Forget settled on the section."
```

---

### Task 6: Package and verify the release

**Files:**
- Modify: none expected. Fix whatever the run turns up.

**Interfaces:**
- Consumes: everything above.
- Produces: a packaged release at version 121 on memory schema 9.

- [ ] **Step 1: Run the complete package command**

Run: `npm --workspace neutron-chipswap run package`
Expected: PASS. This runs `validate`, `build`, `mopack`, `schema`, `package:metadata`, and `pack`. `validate` is what checks the manifest's memory declaration forms exactly one path from every supported installed version to 9.

- [ ] **Step 2: Run the app's full test suite**

Run: `npm --workspace neutron-chipswap run test`
Expected: PASS. Packaging succeeding does not mean the app's tests ran; this is the command that runs both.

- [ ] **Step 3: Confirm the migration coverage actually executed**

Run: `npm --workspace neutron-chipswap run test:motoko 2>&1 | tail -20`
Expected: output naming `test/memory_v9.test.mo` and `test/trade_history.test.mo`. If either is absent, it was never added to the script in `package.json` and its assertions have not run.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore: package chipswap 121 on memory schema 9"
```

Publication (`npm run updates:publish`) is deliberately **not** part of this plan. It is a production action with no interactive confirmation, and it is the owner's to take.

---

## Self-Review

**Spec coverage.** Every section maps to a task: §4 schema and §5 migration to Task 1; §6 write sites to Task 2; §7 retention to Task 2 (primitives) and Task 3 (endpoints); §8 endpoints to Task 3; §9 frontend to Tasks 4 and 5; §10 testing spread across all; §11 release to Tasks 3 and 6.

**Two places the plan is deliberately provisional,** because the fixture contents cannot be known without reading them at execution time, and both say so inline: the `freshMem` helper in Task 2 Step 1 (design API signatures) and Task 3 Step 10 (whether the chain fixture's outgoing row is live or terminal).

**Type consistency.** `ours`/`theirs`/`escrow_key` are used identically in the schema (Task 1), the funnel (Task 2), the view (Task 3), the parser (Task 4), and the panel (Task 5). `entry_id` is a `Nat` throughout and is sent as a string in the JSON argument, matching how `design_id` is already sent. `completeDelivery`'s changed four-argument signature is defined in Task 2 Step 9 and called in Task 2 Step 10.
