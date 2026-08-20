import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Directory "../backend/Directory";
import Holdings "../backend/Holdings";
import Memory "../backend/memory/chipswap/v2";
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

let self = principalOf(1);
let alice = principalOf(2);
let bob = principalOf(3);

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

let mem = Memory.init();

// A canister is noted once; later sightings only refresh the timestamp.
assert (Directory.note(mem, alice, #manual, 100));
assert (Directory.note(mem, alice, #trade, 200) == false);
assert (Map.size(mem.directory) == 1);
let ?entry = Directory.get(mem, alice) else Runtime.trap("entry missing");
assert (entry.source == #manual);
assert (entry.first_seen_ns == 100);
assert (entry.last_seen_ns == 200);
assert (entry.announced == false);

// We never add ourselves, and non-canister principals are refused.
assert (Directory.note(mem, self, #manual, 100) == true);
assert (Directory.noteExcludingSelf(mem, self, self, #manual, 100) == false);
assert (Map.size(mem.directory) == 2);
ignore Directory.remove(mem, self);

Directory.markAnnounced(mem, alice, 300);
let ?announced = Directory.get(mem, alice) else Runtime.trap("entry missing");
assert (announced.announced);
assert (announced.last_seen_ns == 300);

// Merging a peer's shared directory skips us, skips duplicates, and is bounded.
let sharedPrincipals = Array.tabulate<Principal>(40, func(i) { principalOf(1000 + i) });
// The cap bounds how many principals one exchange makes us examine, so the
// already-known alice consumes a slot without adding an entry.
let added = Directory.merge(mem, Array.concat<Principal>([self, alice], sharedPrincipals), self, 400);
assert (added + 1 == Directory.MAX_SHARE);
assert (Map.size(mem.directory) == Directory.MAX_SHARE);

// Sharing is capped and never includes us.
let share = Directory.share(mem, self, Directory.MAX_SHARE);
assert (share.size() == Directory.MAX_SHARE);
for (candidate in share.values()) assert (candidate != self);
let unique = Array.sort<Principal>(share, Principal.compare);
var index = 1;
while (index < unique.size()) {
    assert (unique[index - 1] != unique[index]);
    index += 1;
};
assert (Directory.share(mem, self, 3).size() == 3);
assert (Directory.share(mem, self, 0).size() == 0);

// Removal works and is honest about misses.
assert (Directory.remove(mem, alice));
assert (Directory.remove(mem, alice) == false);

// Eviction protects announced peers and peers whose chips we hold.
let evicting = Memory.init();
assert (Directory.note(evicting, alice, #manual, 10));
Directory.markAnnounced(evicting, alice, 10);
assert (Directory.note(evicting, bob, #trade, 11));
switch (Holdings.admit(evicting, chip(bob, 1, 1))) {
    case (#ok(())) {};
    case (#err(code)) Runtime.trap(code);
};
var seed = 5000;
while (Map.size(evicting.directory) < Directory.MAX_DIRECTORY) {
    ignore Directory.note(evicting, principalOf(seed), #exchange, 12);
    seed += 1;
};
assert (Map.size(evicting.directory) == Directory.MAX_DIRECTORY);
assert (Directory.note(evicting, principalOf(seed), #exchange, 13));
assert (Map.size(evicting.directory) == Directory.MAX_DIRECTORY);
assert (Directory.get(evicting, alice) != null);
assert (Directory.get(evicting, bob) != null);

// Catalogs are cached per designer and evicted least-recently-fetched first.
let store = Memory.init();
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
    ignore Directory.note(store, extra, #exchange, 70);
    Directory.storeCatalog(store, extra, [cachedDesign(1, OPEN, false)], 70 + cacheSeed);
    cacheSeed += 1;
};
assert (Map.size(store.catalog_cache) == Directory.MAX_CATALOG_CACHE);
Directory.storeCatalog(store, principalOf(cacheSeed), [cachedDesign(1, OPEN, false)], 99_999);
assert (Map.size(store.catalog_cache) == Directory.MAX_CATALOG_CACHE);
// Alice's was the oldest fetch, so it is the one that left.
assert (Map.get(store.catalog_cache, Principal.compare, alice) == null);
assert (Map.get(store.catalog_cache, Principal.compare, bob) != null);

// Store rows apply the three filter axes independently and together.
let rows = Memory.init();
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

func runQuery(
    ownership : Text,
    designerOwnership : Text,
    policy : Text,
    nsfw : Text,
) : Directory.StorePage {
    Directory.storeRows(
        rows,
        {
            ownership;
            designer_ownership = designerOwnership;
            policy;
            nsfw;
        },
        0,
        50,
    );
};

// One of the four is tagged, so the default store is three rows and says so.
assert (runQuery("all", "all", "all", "hide").total == 3);
assert (runQuery("all", "all", "all", "hide").nsfw_hidden == 1);
assert (runQuery("all", "all", "all", "show").total == 4);
assert (runQuery("all", "all", "all", "show").nsfw_hidden == 0);

assert (runQuery("owned", "all", "all", "show").total == 1);
assert (runQuery("not_owned", "all", "all", "show").total == 3);
assert (runQuery("all", "owner_of_designer", "all", "show").total == 2);
assert (runQuery("all", "not_owner_of_designer", "all", "show").total == 2);

// The policy axis: two designs ask for nothing, one wants approval, one has a
// requirement about the artwork. "Swaps freely" and "has requirements" are not
// opposites, and a design that only wants approval is neither.
assert (runQuery("all", "all", "open", "show").total == 2);
assert (runQuery("all", "all", "approval", "show").total == 1);
assert (runQuery("all", "all", "requirements", "show").total == 1);
assert (runQuery("not_owned", "owner_of_designer", "approval", "show").total == 1);
assert (runQuery("owned", "not_owner_of_designer", "all", "show").total == 0);

// Hiding tagged chips narrows every other axis with it.
assert (runQuery("all", "all", "open", "hide").total == 1);
assert (runQuery("all", "all", "open", "hide").nsfw_hidden == 1);

let ownedRows = runQuery("owned", "all", "all", "show");
assert (ownedRows.rows[0].designer == alice);
assert (ownedRows.rows[0].design_id == 1);
assert (ownedRows.rows[0].owned);
assert (ownedRows.rows[0].owns_designer);
assert (ownedRows.rows[0].fetched_at_ns == 10);

// Paging reports the filtered total, not the cached total.
let paged = Directory.storeRows(
    rows,
    {
        ownership = "all";
        designer_ownership = "all";
        policy = "open";
        nsfw = "show";
    },
    1,
    10,
);
assert (paged.total == 2);
assert (paged.rows.size() == 1);

// A row carries the whole policy, so the tile can pre-check an offer against it.
let pickyRows = runQuery("all", "all", "requirements", "show");
assert (pickyRows.rows[0].requirements.min_colors == ?6);
assert (not pickyRows.rows[0].nsfw);
let taggedRows = runQuery("all", "all", "open", "show");
assert (taggedRows.rows[1].nsfw);

// An unknown filter value is rejected rather than silently widened.
func filterOf(ownership : Text, designer : Text, policy : Text, nsfw : Text) : Directory.StoreFilter {
    { ownership; designer_ownership = designer; policy; nsfw };
};
assert (Directory.validFilter(filterOf("all", "all", "all", "hide")));
assert (Directory.validFilter(filterOf("all", "all", "requirements", "show")));
assert (Directory.validFilter(filterOf("nope", "all", "all", "hide")) == false);
assert (Directory.validFilter(filterOf("all", "nope", "all", "hide")) == false);
assert (Directory.validFilter(filterOf("all", "all", "nope", "hide")) == false);
assert (Directory.validFilter(filterOf("all", "all", "all", "nope")) == false);
