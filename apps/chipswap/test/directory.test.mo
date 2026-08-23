import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Directory "../backend/Directory";
import Holdings "../backend/Holdings";
import Memory "../backend/memory/chipswap/v7";
import Shape "../backend/Shape";

func principalOf(seed : Nat) : Principal {
    Principal.fromBlob(
        Blob.fromArray([
            Nat8.fromNat(seed / 65536 % 256),
            Nat8.fromNat(seed / 256 % 256),
            Nat8.fromNat(seed % 256),
            1,
        ])
    );
};

// Every fixture below builds the exact table it means to test, so it starts
// from a blank one rather than from the clean install. `init()` now ships with
// the seed designer, and counting an entry these tests never put there would
// make each assertion say one thing and check another.
func blank() : Memory.Mem {
    let mem = Memory.init();
    Map.remove(mem.directory, Principal.compare, Memory.seedDesigner());
    mem;
};

let self = principalOf(1);
let alice = principalOf(2);
let bob = principalOf(3);
let carol = principalOf(4);

let art : Memory.Art = {
    shape_id = Shape.SHAPE_ID;
    palette = [0x000000];
    pixels = Blob.fromArray(Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(_) { 0 }));
};

func chip(designer : Principal, designId : Nat, serial : Nat) : Memory.Chip {
    {
        ref = { designer; design_id = designId; serial };
        title = "Chip";
        art;
        nsfw = false;
        design_revision = 1;
        minted_at_ns = 1;
        acquired_at_ns = 1;
        state = #held;
    };
};

let mem = blank();

// A canister is noted once; later sightings only refresh the timestamp.
assert (Directory.note(mem, alice, #manual, 100));
assert (Directory.note(mem, alice, #trade, 200) == false);
assert (Map.size(mem.directory) == 1);
let ?entry = Directory.get(mem, alice) else Runtime.trap("entry missing");
assert (entry.source == #manual);
assert (entry.first_seen_ns == 100);
assert (entry.last_seen_ns == 200);
assert (entry.ignored == false);
assert (entry.retired == false);
assert (entry.strikes == 0);
assert (Directory.ignored(mem, alice) == false);
assert (Directory.retired(mem, alice) == false);
// Nothing to set the flag on is a miss, not a silent no-op.
assert (Directory.setIgnored(mem, principalOf(999), true) == false);

// We never add ourselves, and non-canister principals are refused.
assert (Directory.note(mem, self, #manual, 100) == true);
assert (Directory.noteExcludingSelf(mem, self, self, #manual, 100) == false);
assert (Map.size(mem.directory) == 2);
ignore Directory.remove(mem, self);

// Removal works and is honest about misses.
assert (Directory.remove(mem, alice));
assert (Directory.remove(mem, alice) == false);

// Eviction protects the designers the owner chose, the ones whose chips we
// hold, and the ones a flag says something about. A crawl arriving with five
// hundred names must not be able to push out a principal typed in by hand.
let evicting = blank();
assert (Directory.note(evicting, alice, #manual, 10));
assert (Directory.note(evicting, bob, #trade, 11));
switch (Holdings.admit(evicting, chip(bob, 1, 1))) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
// Ignoring is a decision, and an evicted decision is no decision at all: the
// next crawl would hand carol back with a clean slate.
assert (Directory.note(evicting, carol, #crawl, 11));
assert (Directory.setIgnored(evicting, carol, true));
var seed = 5000;
while (Map.size(evicting.directory) < Directory.MAX_DIRECTORY) {
    ignore Directory.note(evicting, principalOf(seed), #crawl, 12);
    seed += 1;
};
assert (Map.size(evicting.directory) == Directory.MAX_DIRECTORY);
assert (Directory.note(evicting, principalOf(seed), #crawl, 13));
assert (Map.size(evicting.directory) == Directory.MAX_DIRECTORY);
assert (Directory.get(evicting, alice) != null);
assert (Directory.get(evicting, bob) != null);
assert (Directory.get(evicting, carol) != null);
assert (Directory.ignored(evicting, carol));

// Ignoring reaches two places at once now: what we crawl and what we pass on.
// The entry itself stays, which is the whole point. What the market shows is no
// longer this canister's business — the browser evicts its own copy.
let ignoring = blank();
ignore Directory.note(ignoring, alice, #manual, 10);
ignore Directory.note(ignoring, bob, #manual, 20);
assert (Directory.served(ignoring, self, 0, 10).total == 2);

assert (Directory.setIgnored(ignoring, bob, true));
assert (Directory.ignored(ignoring, bob));
// Still known, so a peer re-sharing bob cannot quietly reinstate him.
assert (Directory.get(ignoring, bob) != null);
assert (Map.size(ignoring.directory) == 2);
assert (Directory.note(ignoring, bob, #crawl, 50) == false);
assert (Directory.ignored(ignoring, bob));

// And we stop handing bob to the peers who crawl us.
let servedAfter = Directory.served(ignoring, self, 0, 10);
assert (servedAfter.total == 1);
assert (servedAfter.entries[0] == alice);

// Un-ignoring restores the entry to every outward path it left.
assert (Directory.setIgnored(ignoring, bob, false));
assert (Directory.ignored(ignoring, bob) == false);
assert (Directory.served(ignoring, self, 0, 10).total == 2);
assert (Directory.reachable(ignoring, bob));

// --- What a peer's crawl reads ---------------------------------------------

// The page a peer reads is ordered by principal, not by when we last saw the
// designer. A crawler walks this in several calls, and an order that shifts
// between them would make it skip some entries and read others twice.
let serving = blank();
var servingSeed = 20_000;
while (Map.size(serving.directory) < 5) {
    ignore Directory.note(serving, principalOf(servingSeed), #crawl, 100 - servingSeed);
    servingSeed += 1;
};
let firstPage = Directory.served(serving, self, 0, 2);
let secondPage = Directory.served(serving, self, 2, 2);
let lastPage = Directory.served(serving, self, 4, 2);
assert (firstPage.total == 5);
assert (firstPage.entries.size() == 2);
assert (secondPage.entries.size() == 2);
assert (lastPage.entries.size() == 1);
assert (Directory.served(serving, self, 5, 2).entries.size() == 0);
assert (Directory.served(serving, self, 0, 0).entries.size() == 0);

// Walking the pages visits every designer exactly once and in sorted order.
let walked = Array.flatten<Principal>([
    firstPage.entries,
    secondPage.entries,
    lastPage.entries,
]);
assert (walked.size() == 5);
var walkIndex = 1;
while (walkIndex < walked.size()) {
    assert (Principal.compare(walked[walkIndex - 1], walked[walkIndex]) == #less);
    walkIndex += 1;
};

// We never hand a peer our own address, and neither the ignored nor the retired
// travel. Withholding is the whole of what those flags mean to anyone else.
ignore Directory.note(serving, self, #manual, 1);
ignore Directory.note(serving, alice, #manual, 1);
ignore Directory.note(serving, bob, #manual, 1);
assert (Directory.setIgnored(serving, alice, true));
assert (Directory.setRetired(serving, bob, true));
let filtered = Directory.served(serving, self, 0, 100);
assert (filtered.total == 5);
for (candidate in filtered.entries.values()) {
    assert (candidate != self);
    assert (candidate != alice);
    assert (candidate != bob);
};

// --- Retirement -------------------------------------------------------------

// A designer earns retirement over three consecutive unanswered calls, and any
// reply at all resets the count. One bad moment is not an uninstall.
let strikes = blank();
ignore Directory.note(strikes, alice, #manual, 1);
assert (Directory.noteUnreachable(strikes, alice, 2) == false);
assert (Directory.noteUnreachable(strikes, alice, 3) == false);
Directory.noteReachable(strikes, alice, 4);
let ?recovered = Directory.get(strikes, alice) else Runtime.trap("entry missing");
assert (recovered.strikes == 0);
assert (recovered.retired == false);

assert (Directory.noteUnreachable(strikes, alice, 5) == false);
assert (Directory.noteUnreachable(strikes, alice, 6) == false);
// The third is the one that concludes it, and it says so exactly once.
assert (Directory.noteUnreachable(strikes, alice, 7));
assert (Directory.retired(strikes, alice));
assert (Directory.noteUnreachable(strikes, alice, 8) == false);
assert (Directory.reachable(strikes, alice) == false);

// --- Reading one call outcome ----------------------------------------------

// The outcome of a paid call is the only evidence we get about a designer, and
// exactly one code in it is evidence about *them*. Everything else describes
// something that happened on our side, or is an answer we could not read —
// and an answer, however garbled, proves someone is home.
let outcomes = blank();
ignore Directory.note(outcomes, bob, #manual, 1);

// Our own limits are not their fault, so they cost nothing.
assert (
    Directory.noteCallResult(
        outcomes,
        bob,
        #err({ code = "concurrency_limit"; message = "" }),
        2,
    ) == false
);
let ?unblamed = Directory.get(outcomes, bob) else Runtime.trap("entry missing");
assert (unblamed.strikes == 0);

// A rejection is theirs, and three of them retire the designer.
assert (Directory.noteCallResult(outcomes, bob, #err({ code = "call_rejected"; message = "" }), 3) == false);
assert (Directory.noteCallResult(outcomes, bob, #err({ code = "call_rejected"; message = "" }), 4) == false);

// Bytes we cannot decode still came back from a canister that ran, so the
// count resets rather than climbing to the third strike.
assert (Directory.noteCallResult(outcomes, bob, #ok("\00\01\02"), 5) == false);
let ?answered = Directory.get(outcomes, bob) else Runtime.trap("entry missing");
assert (answered.strikes == 0);
assert (answered.retired == false);

// And with nothing to reset it, the third rejection concludes it once.
assert (Directory.noteCallResult(outcomes, bob, #err({ code = "call_rejected"; message = "" }), 6) == false);
assert (Directory.noteCallResult(outcomes, bob, #err({ code = "call_rejected"; message = "" }), 7) == false);
assert (Directory.noteCallResult(outcomes, bob, #err({ code = "call_rejected"; message = "" }), 8));
assert (Directory.retired(outcomes, bob));

// A retired designer reads as ignored everywhere it matters, but the entry
// survives: forgetting them would let the next crawl bring them straight back.
assert (Directory.get(strikes, alice) != null);
assert (Directory.served(strikes, self, 0, 10).total == 0);

// Retiring closes the same outward paths ignoring does, and for the same
// reason: we will not spend another call on this designer.
ignore Directory.note(strikes, bob, #manual, 1);
assert (Directory.reachable(strikes, bob));
assert (Directory.setRetired(strikes, bob, true));
assert (Directory.reachable(strikes, bob) == false);
assert (Directory.served(strikes, self, 0, 10).total == 0);

// A designer put back into rotation gets a full three chances again rather than
// sitting one bad call away from retirement.
assert (Directory.setRetired(strikes, alice, false));
let ?revived = Directory.get(strikes, alice) else Runtime.trap("entry missing");
assert (revived.retired == false);
assert (revived.strikes == 0);
assert (Directory.setRetired(strikes, principalOf(998), false) == false);
assert (Directory.noteUnreachable(strikes, principalOf(998), 1) == false);

// --- What a crawl brings back ------------------------------------------------
//
// The walk itself is the browser's now (src/resident/crawl.ts). What reaches
// this canister is its result: a batch of addresses, arriving once, when the
// crawl is done or stopped. Everything the table decides about a designer
// still gets decided here.

let found = blank();
ignore Directory.note(found, alice, #manual, 1);

// A batch seats the designers it carries and attributes them to the crawl.
let firstBatch = Directory.noteFound(found, [bob, carol], self, 100);
assert (firstBatch.added == 2);
assert (firstBatch.skipped == 0);
assert (firstBatch.full == false);
switch (Directory.get(found, bob)) {
    case (?entry) assert (entry.source == #crawl);
    case null Runtime.trap("a found designer was not seated");
};

// A designer we already had is not added again, and keeps the source that says
// how we actually met them. A crawl reporting alice does not overwrite the fact
// that the owner typed her in.
let repeat = Directory.noteFound(found, [alice, bob], self, 110);
assert (repeat.added == 0);
assert (repeat.skipped == 2);
switch (Directory.get(found, alice)) {
    case (?entry) assert (entry.source == #manual);
    case null Runtime.trap("a known designer was dropped by a batch");
};

// Our own address never enters our own directory, however many peers list it.
let selfBatch = Directory.noteFound(found, [self], self, 120);
assert (selfBatch.added == 0);
assert (selfBatch.skipped == 1);
assert (Directory.get(found, self) == null);

// One batch naming the same designer twice found one designer.
let duplicates = blank();
let twice = Directory.noteFound(duplicates, [alice, alice], self, 130);
assert (twice.added == 1);
assert (twice.skipped == 1);

// An empty batch is a no-op rather than an error: a crawl that found nobody
// still finishes, and still says so.
let nothing = Directory.noteFound(duplicates, [], self, 140);
assert (nothing.added == 0);
assert (nothing.skipped == 0);

// Every address is accounted for. A caller that reported "found 40" while the
// table seated 12 would be describing a crawl that did not happen.
let ceiling = blank();
var filler = 100;
while (Map.size(ceiling.directory) < Directory.MAX_DIRECTORY - 2) {
    ignore Directory.note(ceiling, principalOf(filler), #manual, 10 + filler);
    filler += 1;
};
let overflow = Array.tabulate<Principal>(10, func(i) { principalOf(9_000 + i) });
let squeezed = Directory.noteFound(ceiling, overflow, self, 150);
assert (squeezed.added + squeezed.skipped == overflow.size());
// Chosen entries are never given up for a crawl's finds, so the table stops at
// its limit rather than trading away designers the owner asked for.
assert (squeezed.added == 2);
assert (squeezed.full);
assert (Map.size(ceiling.directory) == Directory.MAX_DIRECTORY);

// Only a peer's own silence is evidence against them. Every other code the
// broker returns describes something that went wrong on this side, and an
// unreadable reply is not a failure to answer at all.
assert (Directory.strikeable("call_rejected"));
assert (Directory.strikeable("concurrency_limit") == false);
assert (Directory.strikeable("capability_revoked") == false);
assert (Directory.strikeable("not_reserved") == false);
assert (Directory.strikeable("reply_limit") == false);
assert (Directory.strikeable("") == false);

// --- The seeded designer -----------------------------------------------------

// The directory tells the owner where each entry came from, and the seed has to
// be able to say "the app came with it". Borrowing one of the other four labels
// would make the one entry they did not cause look like one they did.
assert (Directory.sourceText(#seed) == "seed");

// And it is an arrival, not a decision. A full table gives up the seed before
// any designer the owner typed in, which is the right way round: the seed is
// scaffolding for an empty directory, and a table at its limit is the one case
// where it has plainly done its job.
let seedEviction = blank();
ignore Directory.note(seedEviction, Memory.seedDesigner(), #seed, 1);
var seedFiller = 100;
while (Map.size(seedEviction.directory) < Directory.MAX_DIRECTORY) {
    ignore Directory.note(seedEviction, principalOf(seedFiller), #manual, 10 + seedFiller);
    seedFiller += 1;
};
assert (Map.size(seedEviction.directory) == Directory.MAX_DIRECTORY);
assert (Directory.note(seedEviction, principalOf(9_000), #crawl, 99_999));
switch (Directory.get(seedEviction, Memory.seedDesigner())) {
    case null {};
    case (?_) Runtime.trap("a full table evicted a chosen designer over the seed");
};

// Nothing else about it is special. It is fetched from, served to peers, and
// ignored on exactly the terms every other entry is.
let seeded = blank();
ignore Directory.note(seeded, Memory.seedDesigner(), #seed, 5);
assert (Directory.reachable(seeded, Memory.seedDesigner()));
assert (Directory.served(seeded, self, 0, 10).entries.size() == 1);
assert (Directory.setIgnored(seeded, Memory.seedDesigner(), true));
assert (not Directory.reachable(seeded, Memory.seedDesigner()));
assert (Directory.served(seeded, self, 0, 10).entries.size() == 0);
assert (Directory.remove(seeded, Memory.seedDesigner()));
assert (Directory.get(seeded, Memory.seedDesigner()) == null);
