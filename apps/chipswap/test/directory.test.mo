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
import Memory "../backend/memory/chipswap/v5";
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

func cachedDesign(
    id : Nat,
    requirements : Memory.TradeRequirements,
    nsfw : Bool,
) : Memory.CachedDesign {
    {
        design_id = id;
        title = "Design";
        art;
        requirements;
        nsfw;
        design_revision = 1;
        published_at_ns = 5;
    };
};

func titled(id : Nat, title : Text) : Memory.CachedDesign {
    { cachedDesign(id, Memory.openRequirements(), false) with title };
};

let OPEN = Memory.openRequirements();
let APPROVES = { OPEN with approval = true };
// Restrictive without asking for approval: the two axes are independent.
let PICKY = { OPEN with min_colors = ?6 };

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

// Catalogs are cached per designer and evicted least-recently-fetched first.
let store = blank();
ignore Directory.note(store, alice, #manual, 1);
ignore Directory.note(store, bob, #manual, 1);
Directory.storeCatalog(store, alice, [cachedDesign(1, OPEN, false), cachedDesign(2, APPROVES, false)], 50);
Directory.storeCatalog(store, bob, [cachedDesign(1, APPROVES, false)], 60);
let ?aliceEntry = Directory.get(store, alice) else Runtime.trap("entry missing");
assert (aliceEntry.design_count == 2);
assert (aliceEntry.last_catalog_ns == ?50);

var cacheSeed = 7000;
while (Map.size(store.catalog_cache) < Directory.MAX_CATALOG_CACHE) {
    let extra = principalOf(cacheSeed);
    ignore Directory.note(store, extra, #crawl, 70);
    Directory.storeCatalog(store, extra, [cachedDesign(1, OPEN, false)], 70 + cacheSeed);
    cacheSeed += 1;
};
assert (Map.size(store.catalog_cache) == Directory.MAX_CATALOG_CACHE);
Directory.storeCatalog(store, principalOf(cacheSeed), [cachedDesign(1, OPEN, false)], 99_999);
assert (Map.size(store.catalog_cache) == Directory.MAX_CATALOG_CACHE);
// Alice's was the oldest fetch, so it is the one that left.
assert (Map.get(store.catalog_cache, Principal.compare, alice) == null);
assert (Map.get(store.catalog_cache, Principal.compare, bob) != null);

// --- Market rows ------------------------------------------------------------

// The filter axes apply independently and together, and the page they produce
// reports the filtered total rather than the cached one.
let rows = blank();
Directory.storeCatalog(
    rows,
    alice,
    [cachedDesign(1, OPEN, false), cachedDesign(2, APPROVES, false)],
    10,
);
Directory.storeCatalog(
    rows,
    bob,
    [cachedDesign(1, PICKY, false), cachedDesign(2, OPEN, true)],
    20,
);
switch (Holdings.admit(rows, chip(alice, 1, 1))) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};

func filterOf(
    ownership : Text,
    nsfw : Text,
    requirements : [Text],
    designer : ?Principal,
    search : Text,
    sort : Text,
) : Directory.StoreFilter {
    { ownership; nsfw; requirements; designer; search; sort };
};

func plain(ownership : Text, nsfw : Text) : Directory.StoreFilter {
    filterOf(ownership, nsfw, [], null, "", "designer");
};

func runQuery(ownership : Text, nsfw : Text) : Directory.StorePage {
    Directory.storeRows(rows, plain(ownership, nsfw), 0, 50);
};

// One of the four is tagged, so a market that hides tags is three rows and
// says so.
assert (runQuery("all", "hide").total == 3);
assert (runQuery("all", "hide").nsfw_hidden == 1);
assert (runQuery("all", "show").total == 4);
assert (runQuery("all", "show").nsfw_hidden == 0);

assert (runQuery("owned", "show").total == 1);
assert (runQuery("not_owned", "show").total == 3);

// --- The requirement facets -------------------------------------------------

func facets(list : [Text]) : Directory.StorePage {
    Directory.storeRows(
        rows,
        filterOf("all", "show", list, null, "", "designer"),
        0,
        50,
    );
};

// Two designs ask for nothing, one wants approval, one has a requirement about
// the artwork. "Swaps freely" and "asks something of the artwork" are not
// opposites, and a design that only wants approval is neither.
assert (facets(["open"]).total == 2);
assert (facets(["approval"]).total == 1);
assert (facets(["min_colors"]).total == 1);
assert (facets(["max_coverage"]).total == 0);
assert (facets(["tag_rule"]).total == 0);

// Facets widen each other: two ticked asks for the designs matching either.
assert (facets(["open", "approval"]).total == 3);
assert (facets(["open", "min_colors"]).total == 3);
assert (facets(["open", "approval", "min_colors"]).total == 4);
// Repeating one asks for no more than naming it once.
assert (facets(["open", "open"]).total == 2);
// None ticked is not a facet that matches nothing; it is no constraint at all.
assert (facets([]).total == 4);

// A facet narrows alongside the other axes rather than replacing them.
assert (Directory.storeRows(rows, filterOf("all", "hide", ["open"], null, "", "designer"), 0, 50).total == 1);
assert (Directory.storeRows(rows, filterOf("all", "hide", ["open"], null, "", "designer"), 0, 50).nsfw_hidden == 1);
assert (Directory.storeRows(rows, filterOf("not_owned", "show", ["open"], null, "", "designer"), 0, 50).total == 1);

// --- Trades I can make ------------------------------------------------------

// The facet is answered by measuring what we could offer, not by trusting a
// count: a chip claims nothing about its colors, its pixels are counted.
let colorful : Memory.Art = {
    shape_id = Shape.SHAPE_ID;
    palette = [0x000000, 0x110000, 0x220000, 0x330000, 0x440000, 0x550000];
    pixels = Blob.fromArray(
        Array.tabulate<Nat8>(Shape.PIXEL_COUNT, func(i) { Nat8.fromNat(i % 6) })
    );
};

func chipOf(designer : Principal, designId : Nat, art : Memory.Art, nsfw : Bool) : Memory.Chip {
    {
        ref = { designer; design_id = designId; serial = 1 };
        title = "Chip";
        art;
        nsfw;
        design_revision = 1;
        minted_at_ns = 1;
        acquired_at_ns = 1;
        state = #held;
    };
};

func ownDesign(id : Nat, art : Memory.Art, state : Memory.DesignState) : Memory.Design {
    {
        design_id = id;
        title = "Mine";
        art;
        state;
        requirements = OPEN;
        nsfw = false;
        revision = 1;
        created_at_ns = 1;
        published_at_ns = ?2;
        next_serial = 1;
    };
};

func tradeableIn(mem : Memory.Mem) : Nat {
    Directory.storeRows(
        mem,
        filterOf("all", "show", ["tradeable"], null, "", "designer"),
        0,
        50,
    ).total;
};

func seedCatalogs(mem : Memory.Mem) {
    Directory.storeCatalog(mem, alice, [cachedDesign(1, OPEN, false), cachedDesign(2, APPROVES, false)], 10);
    Directory.storeCatalog(mem, bob, [cachedDesign(1, PICKY, false)], 20);
};

// Nothing to offer means nothing is tradeable, however open the designs are.
let empty = blank();
seedCatalogs(empty);
assert (Directory.storeRows(empty, plain("all", "show"), 0, 50).total == 3);
assert (tradeableIn(empty) == 0);

// A one-color chip satisfies the two that ask nothing of the artwork, and the
// approval design among them: approval decides what happens to an offer that
// already qualifies, not whether it qualifies.
let plainChip = blank();
seedCatalogs(plainChip);
switch (Holdings.admit(plainChip, chipOf(carol, 9, art, false))) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
assert (tradeableIn(plainChip) == 2);

// Six colors clears the six-color minimum, so the picky design joins them.
let sixColors = blank();
seedCatalogs(sixColors);
switch (Holdings.admit(sixColors, chipOf(carol, 9, colorful, false))) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
assert (tradeableIn(sixColors) == 3);

// A published design of our own counts too: offering one mints a fresh copy.
let ownPublished = blank();
seedCatalogs(ownPublished);
Map.add(ownPublished.designs, Nat.compare, 1, ownDesign(1, colorful, #published));
assert (tradeableIn(ownPublished) == 3);

// A draft is not a candidate. It cannot be offered, so it must not make a
// design look reachable that is not.
let ownDraft = blank();
seedCatalogs(ownDraft);
Map.add(ownDraft.designs, Nat.compare, 1, ownDesign(1, colorful, #draft));
assert (tradeableIn(ownDraft) == 0);

// Neither is a chip already committed to a trade in flight.
let escrowed = blank();
seedCatalogs(escrowed);
switch (Holdings.admit(escrowed, chipOf(carol, 9, colorful, false))) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
switch (Holdings.escrow(escrowed, Holdings.key({ designer = carol; design_id = 9; serial = 1 }), Blob.fromArray([1]), bob, 5)) {
    case (#ok(_)) {};
    case (#err(code)) Runtime.trap(code);
};
assert (tradeableIn(escrowed) == 0);

// The tag rule is measured against the offered chip's own tag, so a tagged
// chip cannot satisfy a design that refuses tagged ones.
let refusesTagged = blank();
Directory.storeCatalog(refusesTagged, alice, [cachedDesign(1, { OPEN with nsfw = ?#disallowed }, false)], 10);
switch (Holdings.admit(refusesTagged, chipOf(carol, 9, colorful, true))) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
assert (tradeableIn(refusesTagged) == 0);
switch (Holdings.admit(refusesTagged, chipOf(carol, 10, colorful, false))) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
assert (tradeableIn(refusesTagged) == 1);

// --- Search, designer, and order --------------------------------------------

let sorting = blank();
Directory.storeCatalog(
    sorting,
    alice,
    [titled(1, "Zebra"), titled(2, "Apple")],
    10,
);
Directory.storeCatalog(sorting, bob, [titled(1, "Moon")], 20);

func sorted(sort : Text) : [Text] {
    Array.map<Directory.StoreRow, Text>(
        Directory.storeRows(sorting, filterOf("all", "show", [], null, "", sort), 0, 50).rows,
        func(row) { row.title },
    );
};

// Ties inside one designer's catalog fall back to the design id, so a page
// boundary lands in the same place every time it is asked for.
assert (sorted("recent") == ["Moon", "Zebra", "Apple"]);
assert (sorted("oldest") == ["Zebra", "Apple", "Moon"]);
assert (sorted("title") == ["Apple", "Moon", "Zebra"]);
assert (sorted("designer") == ["Zebra", "Apple", "Moon"]);

func searched(needle : Text) : Nat {
    Directory.storeRows(sorting, filterOf("all", "show", [], null, needle, "designer"), 0, 50).total;
};

assert (searched("") == 3);
assert (searched("Moon") == 1);
// Case is not a decision a reader made, so it is not one the search enforces.
assert (searched("moon") == 1);
assert (searched("MOON") == 1);
// A substring matches, anchored nowhere in particular.
assert (searched("oo") == 1);
assert (searched("e") == 2);
assert (searched("xyzzy") == 0);

func fromDesigner(who : ?Principal) : Nat {
    Directory.storeRows(sorting, filterOf("all", "show", [], who, "", "designer"), 0, 50).total;
};

assert (fromDesigner(null) == 3);
assert (fromDesigner(?alice) == 2);
assert (fromDesigner(?bob) == 1);
// A designer with nothing cached is an empty shelf, not an unfiltered market.
assert (fromDesigner(?carol) == 0);

// --- Rows, paging, and validation -------------------------------------------

// A row carries the whole policy, so the tile can pre-check an offer against it.
let pickyRows = facets(["min_colors"]);
assert (pickyRows.rows[0].requirements.min_colors == ?6);
assert (not pickyRows.rows[0].nsfw);
let taggedRows = facets(["open"]);
assert (taggedRows.rows[1].nsfw);

let ownedRows = runQuery("owned", "show");
assert (ownedRows.rows[0].designer == alice);
assert (ownedRows.rows[0].design_id == 1);
assert (ownedRows.rows[0].owned);
assert (ownedRows.rows[0].fetched_at_ns == 10);

// Paging reports the filtered total, not the cached total.
let paged = Directory.storeRows(
    rows,
    filterOf("all", "show", ["open"], null, "", "designer"),
    1,
    10,
);
assert (paged.total == 2);
assert (paged.rows.size() == 1);

// An unknown filter value is rejected rather than silently widened.
assert (Directory.validFilter(plain("all", "hide")));
assert (Directory.validFilter(filterOf("all", "show", ["open", "tradeable"], ?alice, "moon", "title")));
assert (Directory.validFilter(plain("nope", "hide")) == false);
assert (Directory.validFilter(plain("all", "nope")) == false);
assert (Directory.validFilter(filterOf("all", "hide", ["nope"], null, "", "designer")) == false);
assert (Directory.validFilter(filterOf("all", "hide", [], null, "", "nope")) == false);

// A caller cannot buy unbounded work with a long list or a long search.
func repeatA(count : Nat) : Text {
    Text.join(Array.tabulate<Text>(count, func(_) { "a" }).values(), "");
};
assert (Directory.validFilter(filterOf("all", "hide", Array.tabulate<Text>(Directory.MAX_REQUIREMENT_FACETS, func(_) { "open" }), null, "", "designer")));
assert (
    Directory.validFilter(
        filterOf("all", "hide", Array.tabulate<Text>(Directory.MAX_REQUIREMENT_FACETS + 1, func(_) { "open" }), null, "", "designer")
    ) == false
);
assert (Directory.validFilter(filterOf("all", "hide", [], null, repeatA(Directory.MAX_SEARCH_CHARS), "designer")));
assert (Directory.validFilter(filterOf("all", "hide", [], null, repeatA(Directory.MAX_SEARCH_CHARS + 1), "designer")) == false);


// Ignoring reaches three places at once: what we fetch, what we pass on, and
// what the store shows. The entry itself stays, which is the whole point.
let ignoring = blank();
ignore Directory.note(ignoring, alice, #manual, 10);
ignore Directory.note(ignoring, bob, #manual, 20);
Directory.storeCatalog(ignoring, alice, [cachedDesign(1, OPEN, false)], 30);
Directory.storeCatalog(ignoring, bob, [cachedDesign(1, OPEN, false)], 40);

let openFilter : Directory.StoreFilter = plain("all", "show");
assert (Directory.storeRows(ignoring, openFilter, 0, 50).total == 2);
assert (Directory.served(ignoring, self, 0, 10).total == 2);

assert (Directory.setIgnored(ignoring, bob, true));
assert (Directory.ignored(ignoring, bob));
// Still known, so a peer re-sharing bob cannot quietly reinstate him.
assert (Directory.get(ignoring, bob) != null);
assert (Map.size(ignoring.directory) == 2);
assert (Directory.note(ignoring, bob, #crawl, 50) == false);
assert (Directory.ignored(ignoring, bob));

// The cache went with the flag, so bob's row leaves the store rather than
// sitting there growing stale behind a refresh that will never come.
assert (Map.get(ignoring.catalog_cache, Principal.compare, bob) == null);
assert (Map.get(ignoring.catalog_cache, Principal.compare, alice) != null);
assert (Directory.storeRows(ignoring, openFilter, 0, 50).total == 1);
assert (Directory.storeRows(ignoring, openFilter, 0, 50).rows[0].designer == alice);

// And we stop handing bob to the peers who crawl us.
let servedAfter = Directory.served(ignoring, self, 0, 10);
assert (servedAfter.total == 1);
assert (servedAfter.entries[0] == alice);

// Un-ignoring restores the entry, not the catalog: the store stays quiet
// until the next refresh actually fetches something.
assert (Directory.setIgnored(ignoring, bob, false));
assert (Directory.ignored(ignoring, bob) == false);
assert (Directory.storeRows(ignoring, openFilter, 0, 50).total == 1);
assert (Directory.served(ignoring, self, 0, 10).total == 2);
Directory.storeCatalog(ignoring, bob, [cachedDesign(1, OPEN, false)], 70);
assert (Directory.storeRows(ignoring, openFilter, 0, 50).total == 2);

// A catalog cached before the flag is set is still not shown, so the store
// never depends on the cache having been cleared by exactly one code path.
Directory.storeCatalog(ignoring, bob, [cachedDesign(1, OPEN, false)], 80);
Map.add(
    ignoring.directory,
    Principal.compare,
    bob,
    { (switch (Directory.get(ignoring, bob)) { case (?e) e; case null Runtime.trap("missing") }) with ignored = true },
);
assert (Map.get(ignoring.catalog_cache, Principal.compare, bob) != null);
assert (Directory.storeRows(ignoring, openFilter, 0, 50).total == 1);

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

// Retiring drops the cached catalog, so the store does not keep showing chips
// from a designer nobody will ever refresh again.
ignore Directory.note(strikes, bob, #manual, 1);
Directory.storeCatalog(strikes, bob, [cachedDesign(1, OPEN, false)], 10);
assert (Map.get(strikes.catalog_cache, Principal.compare, bob) != null);
assert (Directory.setRetired(strikes, bob, true));
assert (Map.get(strikes.catalog_cache, Principal.compare, bob) == null);
assert (Directory.storeRows(strikes, openFilter, 0, 50).total == 0);

// A designer put back into rotation gets a full three chances again rather than
// sitting one bad call away from retirement.
assert (Directory.setRetired(strikes, alice, false));
let ?revived = Directory.get(strikes, alice) else Runtime.trap("entry missing");
assert (revived.retired == false);
assert (revived.strikes == 0);
assert (Directory.setRetired(strikes, principalOf(998), false) == false);
assert (Directory.noteUnreachable(strikes, principalOf(998), 1) == false);

// --- The crawl --------------------------------------------------------------

let crawling = blank();
ignore Directory.note(crawling, alice, #manual, 1);
ignore Directory.note(crawling, bob, #manual, 1);
ignore Directory.note(crawling, carol, #manual, 1);
assert (Directory.setIgnored(crawling, carol, true));

// Nothing to do until a crawl is started, and no state to trip over.
assert (Directory.crawling(crawling) == false);
assert (Directory.crawlTargets(crawling, 8).size() == 0);
assert (Directory.crawlProgress(crawling).active == false);

Directory.startCrawl(crawling, 100);
assert (Directory.crawling(crawling));
// The frontier is the directory: everyone eligible, and carol is not.
let opening = Directory.crawlProgress(crawling);
assert (opening.remaining == 2);
assert (opening.queried == 0);
assert (opening.discovered == 0);
let firstTargets = Directory.crawlTargets(crawling, 8);
assert (firstTargets.size() == 2);
for (target in firstTargets.values()) {
    assert (target.canister != carol);
    assert (target.offset == 0);
};
// A batch smaller than the frontier takes part of it.
assert (Directory.crawlTargets(crawling, 1).size() == 1);
assert (Directory.crawlTargets(crawling, 0).size() == 0);

// A peer whose directory is longer than one page keeps a cursor, and the next
// batch returns to them before starting anyone new.
let discovered = Directory.noteCrawlPage(crawling, alice, 0, [principalOf(31), principalOf(32)], 5, self, 200);
assert (discovered == 2);
assert (Map.size(crawling.directory) == 5);
let midway = Directory.crawlTargets(crawling, 8);
assert (midway[0].canister == alice);
assert (midway[0].offset == 2);

// Whatever a crawl finds is saved, and found twice is not found again.
assert (Directory.noteCrawlPage(crawling, alice, 2, [principalOf(31), principalOf(33)], 5, self, 210) == 1);
// Our own address never enters our own directory, however many peers list it.
assert (Directory.noteCrawlPage(crawling, alice, 4, [self], 5, self, 220) == 0);
assert (Directory.get(crawling, self) == null);
// The last page drains the peer: offset plus what they sent reached their total.
assert (Directory.crawlProgress(crawling).queried == 1);
for (target in Directory.crawlTargets(crawling, 8).values()) {
    assert (target.canister != alice);
};

// A peer who says nothing is finished rather than asked forever.
assert (Directory.noteCrawlPage(crawling, bob, 0, [], 9, self, 230) == 0);
assert (Directory.crawlProgress(crawling).queried == 2);

// Ignoring a designer mid-crawl takes them out of the frontier without anything
// having to be told: the frontier is derived, so there is no queue to correct.
let beforeIgnoring = Directory.crawlProgress(crawling).remaining;
assert (beforeIgnoring == 3);
assert (Directory.setIgnored(crawling, principalOf(31), true));
assert (Directory.crawlProgress(crawling).remaining == 2);

// Progress accumulates across the whole crawl rather than per step.
let running = Directory.crawlProgress(crawling);
assert (running.active);
assert (running.queried == 2);
assert (running.discovered == 3);
assert (running.full == false);

// Stopping clears the state, and a stopped crawl accepts no more pages.
Directory.stopCrawl(crawling);
assert (Directory.crawling(crawling) == false);
assert (Directory.noteCrawlPage(crawling, bob, 0, [principalOf(41)], 1, self, 240) == 0);
assert (Directory.get(crawling, principalOf(41)) == null);
assert (Directory.crawlTargets(crawling, 8).size() == 0);

// Starting again re-visits everyone a crawl may still reach: the two we asked
// last time and the two they taught us about, but not the two that are ignored.
// A crawl that finished has nothing left to resume, which is why starting over
// is a separate decision rather than a continuation.
Directory.startCrawl(crawling, 300);
assert (Directory.crawlProgress(crawling).remaining == 4);
assert (Directory.crawlProgress(crawling).queried == 0);
assert (Directory.crawlProgress(crawling).discovered == 0);

// Only a peer's own silence is evidence against them. Every other code the
// broker returns describes something that went wrong on this side, and an
// unreadable reply is not a failure to answer at all.
assert (Directory.strikeable("call_rejected"));
assert (Directory.strikeable("concurrency_limit") == false);
assert (Directory.strikeable("capability_revoked") == false);
assert (Directory.strikeable("not_reserved") == false);
assert (Directory.strikeable("reply_limit") == false);
assert (Directory.strikeable("") == false);

// A peer who claims a directory far larger than anyone can hold, and hands it
// over one entry at a time, is paged to the honest ceiling and no further.
let lying = blank();
ignore Directory.note(lying, alice, #manual, 1);
Directory.startCrawl(lying, 1);
var lyingPages = 0;
label paging loop {
    var pending : ?Nat = null;
    for (target in Directory.crawlTargets(lying, 8).values()) {
        if (target.canister == alice) pending := ?target.offset;
    };
    switch (pending) {
        case null break paging;
        case (?offset) {
            ignore Directory.noteCrawlPage(
                lying,
                alice,
                offset,
                [bob],
                4_294_967_295,
                self,
                2,
            );
            lyingPages += 1;
        };
    };
    // A safety net well above the ceiling, so a regression fails this test
    // rather than hanging it.
    if (lyingPages > Directory.MAX_DIRECTORY + 8) break paging;
};
assert (lyingPages == Directory.MAX_DIRECTORY);
for (target in Directory.crawlTargets(lying, 8).values()) {
    assert (target.canister != alice);
};

// A page that does not answer the question we asked is refused. A reply that
// arrives after a crawl was restarted describes a position in a walk that no
// longer exists, and acting on it would mark a peer finished whose beginning
// this crawl never read.
let stale = blank();
ignore Directory.note(stale, alice, #manual, 1);
Directory.startCrawl(stale, 1);
// Part-way through a long directory.
assert (Directory.noteCrawlPage(stale, alice, 0, [principalOf(61)], 9, self, 2) == 1);
// The same crawl, but a page from a position we are not at.
assert (Directory.noteCrawlPage(stale, alice, 0, [principalOf(62)], 9, self, 3) == 0);
assert (Directory.get(stale, principalOf(62)) == null);
assert (Directory.noteCrawlPage(stale, alice, 7, [principalOf(63)], 9, self, 4) == 0);
assert (Directory.get(stale, principalOf(63)) == null);
// The page we are actually waiting for still lands.
assert (Directory.noteCrawlPage(stale, alice, 1, [principalOf(64)], 9, self, 5) == 1);

// After a restart the walk begins again, so the tail of the old one is refused
// while a fresh first page is accepted.
Directory.startCrawl(stale, 6);
assert (Directory.noteCrawlPage(stale, alice, 2, [principalOf(65)], 9, self, 7) == 0);
assert (Directory.get(stale, principalOf(65)) == null);
assert (Directory.noteCrawlPage(stale, alice, 0, [principalOf(65)], 9, self, 8) == 1);

// A peer already drained this crawl is not re-read by a late reply either.
Directory.finishCrawlPeer(stale, alice);
assert (Directory.noteCrawlPage(stale, alice, 0, [principalOf(66)], 9, self, 9) == 0);
assert (Directory.get(stale, principalOf(66)) == null);

// A cursor can outlive the entry it points at. Removing or ignoring a designer
// whose directory is half-read takes them out of the batch as well as out of
// the count, so the two never disagree about what is left.
let orphaned = blank();
ignore Directory.note(orphaned, alice, #manual, 1);
ignore Directory.note(orphaned, bob, #manual, 1);
Directory.startCrawl(orphaned, 1);
assert (Directory.noteCrawlPage(orphaned, alice, 0, [principalOf(71)], 9, self, 2) == 1);
assert (Directory.noteCrawlPage(orphaned, bob, 0, [principalOf(72)], 9, self, 2) == 1);
assert (Directory.crawlTargets(orphaned, 8).size() == 4);
assert (Directory.remove(orphaned, alice));
assert (Directory.setIgnored(orphaned, bob, true));
for (target in Directory.crawlTargets(orphaned, 8).values()) {
    assert (target.canister != alice);
    assert (target.canister != bob);
};
assert (Directory.crawlProgress(orphaned).remaining == 2);

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
