# Chipswap directory discovery: a pulled crawl instead of a pushed exchange

## Why

Directory information currently rides on every peer message. `catalog`,
`trade`, and `deliver` each carry up to 32 principals in each direction,
`announce` exists only to push a principal into a peer's table, and an
`auto_announce` setting fanned that out further. Discovery is therefore a
side effect of unrelated traffic: an owner who fetches one catalogue may
gain a dozen designers they never asked for and publish themselves to
peers they never chose.

This replaces the whole arrangement with one owner-triggered pull.

## What stays

- Adding a designer by principal, and adding one from Contacts.
- Ignoring a designer, which keeps withholding them from peers.
- Recording the proposer of an inbound trade, so trading remains the way
  a new install enters the graph.

## What goes

- The `announce` route, `chipswap_announce`, `chipswap_announce_v1`, the
  `announced` flag, and the announce UI.
- The `directory` field on every `catalog` / `trade` / `deliver` message,
  in both directions.
- `Directory.merge` and `Directory.share`, and every call site.

## The crawl

### The route

A fifth route replaces `announce`, in query mode:

```json
{ "protocol": "chipswap_v1", "id": "directory",
  "handler": "chipswap_directory_v1", "mode": "query", "caller": "canister",
  "max_request_bytes": 1024, "max_response_bytes": 8192 }
```

Request is ordinary Candid `{ offset : Nat; limit : Nat }`. The reply is a
new CSW1 message carrying `{ entries : [Principal]; total : Nat }`, capped
at 128 principals per page (128 x 29 B = 3712 B, inside the 8 KB ceiling).

It serves every entry that is neither ignored nor retired, ordered by
`Principal.compare`. The order is deliberately not `last_seen_ns`: a sort
that shifts between calls makes a paginated read skip and repeat entries.

Being a query it carries no cycles floor, is exempt from the paid-route
rate limits, and cannot write. A crawl therefore leaves no trace on the
peer and teaches them nothing. It needs a second install reservation, for
`app_chipswap__chipswap_v1_query`.

### The frontier is the directory

Every discovered principal is saved on arrival, so there is no separate
queue to keep consistent with the table. Crawl state is only:

```motoko
public type Crawl = {
    started_at_ns : Int;
    var queried : Nat;
    var discovered : Nat;
    visited : Map.Map<Principal, ()>;   // drained, or given up on
    cursors : Map.Map<Principal, Nat>;  // peer -> next offset, mid-pagination
};
```

The frontier is derived: entries that are not ignored, not retired, and
not visited. Ignoring a designer mid-crawl drops them from the frontier
for free, and queue and directory cannot disagree.

### One step

`chipswap_crawl_step` builds a batch of at most 8 targets — peers with an
open cursor first, then unvisited ones — issues one `call_batch`, and for
each reply notes the principals with source `#crawl`, counting only the
genuinely new. When `offset + returned < total` the cursor advances;
otherwise the peer is marked visited. A failed query marks the peer
visited for this crawl and is **not** a strike: a peer on the current
release has no query dispatcher at all, and must not be retired for
having yet to upgrade.

The step returns `{ active; queried; discovered; remaining; full }`, where
`full` reports that the directory reached `MAX_DIRECTORY` and further
discoveries are being dropped. The loop ends when `remaining` is zero.

Two things a hostile or restarted peer could otherwise do are refused
outright. A page whose offset is not the one this crawl is waiting for is
discarded — a reply arriving after a restart describes a position in a
walk that no longer exists, and acting on it would mark a peer finished
whose beginning was never read. And paging stops at `MAX_DIRECTORY` as
well as at the peer's declared total, so a peer claiming four billion
entries and handing them over one at a time gets four pages like
everybody else.

The tile drives `start`, then `step` until nothing remains, showing
`asked / to go / new` with a Stop button. Because the state is stable,
`chipswap_status` reports an interrupted crawl, and the tile offers to
carry on from where it stopped rather than starting over.

## Retirement

A designer who uninstalls Chipswap leaves a canister that no longer
answers our dispatcher. The kernel discards the IC reject code and hands
the app only `#err({ code = "call_rejected"; message })`, so an uninstall
is not distinguishable in one call from a canister that is stopped,
frozen, or out of cycles. Retirement is therefore earned rather than
inferred:

- Each entry carries `strikes : Nat` and `retired : Bool`.
- Only the **update** routes score: `catalog`, `trade`, `deliver`. A
  successful call resets `strikes` to zero; a `call_rejected` increments
  it; `RETIRE_STRIKES = 3` consecutive rejections set `retired`.
- Which codes count lives in one place, `Directory.strikeable`, next to
  the flag it feeds. Other codes (`concurrency_limit`, `capability_*`,
  `not_reserved`) are our own failures and never strike.
- A wire-parse failure never strikes: the call succeeded, the bytes were
  unreadable.
- A retired designer is treated exactly as an ignored one: not fetched,
  not crawled, not served to peers, not shown in the store.
- An inbound trade proposal from a retired designer proves they are back,
  and clears the flag. The owner can also clear it by hand.

## Eviction

`evictOne` protects entries that are announced or hold a chip. With
`announce` gone, and a crawl now able to add hundreds of entries, that
would let a crawl evict designers the owner typed in by hand. The
protected set becomes: ignored, retired, holds a chip from, or a source
of `#manual` or `#contacts`. Least-recently-seen among the rest is
evicted, and if everything is protected the table stops growing.

## What was built beyond the design

Two guards were added during implementation, both for cases the design
did not name: the stale-page refusal described above, and dropping a
cursor whose directory entry was removed or ignored while its owner's
directory was half-read. Both keep the derived frontier and the table
from disagreeing about what is left.

## Wire

CSW1 goes to version 3. The `directory` field is removed from the catalog
and trade replies, the announce message type is removed, and a directory
message type is added. Version 2 bytes are refused rather than misread,
so an install on the current release and one on the next cannot trade
until both update. `MAX_DIRECTORY_SHARE` (32) becomes
`MAX_DIRECTORY_PAGE` (128).

Peer *requests* are Candid, and Candid ignores unknown record fields, so
removing `directory` from the request records is tolerated in that
direction regardless.

## Memory

Schema v4, migrated from v3. `announced` is dropped; `retired = false`
and `strikes = 0` are added; `crawl` starts empty. The two source
variants that no longer occur are mapped rather than kept as dead
constructors: `#exchange` becomes `#crawl` (it did mean "learned from a
peer's directory"), and `#announce` becomes `#trade` (it did mean "they
contacted us"). v3 and its migration are released and are not edited.

## Tile

- Directory: the announce button and column tag go; a **Find more
  designers** control drives the crawl loop with live progress and Stop;
  ignored and retired rows carry tags and an action to reverse each.
- Store: unchanged apart from excluding retired designers from refresh
  targets.

## Testing

- `directory.test.mo`: page ordering and pagination stability, ignored
  and retired withheld, frontier selection, dedupe, cursor advance,
  eviction protection, strike accumulation, retirement, revival.
- `wire.test.mo`: v3 header, directory message round trip, refusal of v2
  bytes, oversized page refused.
- `main.test.mo`: a crawl step against fixture call results, retirement
  after three rejections, no strike from a failed crawl query.
- `memory_migration.test.mo`: v3 to v4, including both source mappings.
- `package.test.ts`: routes, reservations, self-calls, memory declaration.
- `api.test.ts`: the new client calls.
