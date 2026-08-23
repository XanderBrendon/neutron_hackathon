# Chipswap: the crawl moves to the client

## 1. What changes

The directory crawl stops being a backend activity. Today the tile drives
`chipswap_crawl_start`, then loops `chipswap_crawl_step` until the frontier is
empty, and each step spends an inter-canister call per peer and writes both the
discovered designers and the crawl's own bookkeeping into managed memory.

After this change the browser queries peers directly for their directory pages,
holds every intermediate detail in ordinary JavaScript memory, and tells the
backend once — when the crawl finishes, is stopped, or fails — which designers
it found. The backend keeps the directory. It no longer keeps a crawl.

This mirrors the change already made for catalogs, which the browser now fetches
and caches itself.

## 2. Why

Three separate costs go away.

**Cycles.** A crawl of forty designers was forty inter-canister calls the owner's
canister paid for, to read data that is public and that the browser can fetch
anonymously for free.

**Persistence.** `mem.crawl` held a visited set and a cursor map for a walk that
is meaningful for about ninety seconds. It survived upgrades, it survived the
tile closing, and it had to be reasoned about in every migration. It described a
moment, and managed memory is for things that outlive moments.

**A split state machine.** The frontier lived in the canister, the loop lived in
the tile, and neither could be tested without the other. The whole walk becomes
one testable module with no network and no canister in it.

## 3. What stays in the backend

The directory itself — who the owner knows, how they met, whether they answer,
whether the owner wants to hear from them. Every judgement about a designer stays
where the owner's data is:

- `MAX_DIRECTORY = 512` and the eviction rule that enforces it.
- `ignored` and `retired`, and the strike count behind `retired`.
- The `#crawl` source attribution on an entry the crawl introduced.
- `chipswap_directory_v1`, the page this canister serves to *other* people's
  crawls. Serving is not crawling; that route is untouched except for who may
  call it.

## 4. Decisions taken

| Question | Decision |
| --- | --- |
| Where the crawl runs | The resident background, driven by the tile through tools |
| If the tile closes mid-crawl | The crawl continues and still commits |
| When the backend is written | Once, on completion, on stop, and on error |
| Peers on an older release | Counted and named in the UI, never struck |

### 4.1 Why the background and not the tile

Only `public/service.html` carries a CSP with
`connect-src 'self' https://*.icp0.io`; the tile's `index.html` has none, so a
tile cannot reach a gateway. `test/package.test.ts` asserts as much, requiring
`app_chipswap__chipswap_v1_query` to appear in the background bundle and not in
the tile's. The background is also the surface that already owns
`src/resident/agent.ts`, the anonymous-query path this reuses.

The crawl keeps nothing on disk. `persistent_browser_storage` is the catalog
cache's; the crawl is a variable in the background's module scope and dies with
the process, which is exactly the lifetime asked for.

## 5. The peer-facing change

`chipswap_directory_v1` currently declares `"caller": "canister"`. An anonymous
browser query is refused with `unauthorized`. The route becomes `"caller":
"any"`, matching what `catalog` already did.

The consequence is real and is not hidden: a peer still on version 116 or
earlier refuses a browser's directory query, so a crawl finds nothing from them
until they upgrade. Three things follow from that.

- An `unauthorized` reply is **not** a strike. It says the peer has not upgraded,
  not that they are gone. This is the rule the backend crawl already followed for
  the same reason, and `src/resident/agent.ts` already reads that code this way
  for catalogs.
- The tile reports the count: "12 of 30 designers are on an older release and
  could not be asked." An owner who sees an empty crawl deserves to know why.
- Nothing about the served page changes — same wire, same pagination, same
  withholding of ignored and retired entries.

## 6. Backend

### 6.1 Memory v7

`v6.mo` is released and immutable. `v7.mo` is v6 with the `Crawl` type and
`var crawl : ?Crawl` removed, and the now-unused `Set` import dropped. Every
other type is v6's, unchanged.

`v6_to_v7.mo` is a projection that drops the field:

```motoko
public func migrate(old : V6.Mem) : V7.Mem {
    {
        var revision = old.revision;
        var next_request_seq = old.next_request_seq;
        var next_brush_id = old.next_brush_id;
        designs = old.designs;
        holdings = old.holdings;
        directory = old.directory;
        incoming = old.incoming;
        outgoing = old.outgoing;
        replay = old.replay;
        brushes = old.brushes;
    };
};
```

Unlike v5→v6 this needs no map rebuild: `DirectoryEntry` is unchanged between
the two versions, so the existing maps carry across by reference.

An install that upgrades mid-crawl loses the crawl. That is correct — the walk
it described cannot be resumed by a canister that no longer crawls, and the
designers it had already found were written to `directory` as it went.

### 6.2 Directory.mo

The entire `--- Crawl ---` section is deleted: `CrawlProgress`, `CrawlTarget`,
`startCrawl`, `stopCrawl`, `crawling`, `crawlTargets`, `noteCrawlPage`,
`finishCrawlPeer`, `crawlProgress`.

One function is added, because the commit is a batch and a loop of single
`note` calls would be a loop of update calls:

```motoko
public type FoundSummary = { added : Nat; skipped : Nat; full : Bool };

public func noteFound(
    mem : Memory.Mem,
    canisters : [Principal],
    self : Principal,
    now : Int,
) : FoundSummary
```

It calls `noteExcludingSelf(…, #crawl, now)` per entry and counts. `skipped`
covers both an entry already present and one the table had no room for;
`full` reports whether the table is at `MAX_DIRECTORY` when the batch ends.

This distinction matters and is the reason the summary is returned rather than a
bare revision. `Directory.note` attempts one eviction and then silently returns
`false` if the table is still full. A crawl that found forty designers and could
seat twelve must say so, not claim forty.

### 6.3 main.mo

Removed: `chipswap_crawl_start`, `chipswap_crawl_stop`, `chipswap_crawl_step`,
the `CrawlResult` and `CrawlView` types, `crawlView()`, `directoryFromResult()`,
and the constants `MAX_CRAWL_TARGETS`, `CRAWL_PAGE`, `ROUTE_DIRECTORY`,
`MAX_DIRECTORY_REPLY_BYTES`.

`StatusView` loses its `crawl : CrawlView` field. The tile learns whether a crawl
is running by asking the background, which is the only thing that knows.

`PeerDirectoryRequest`, `INGRESS_QUERY_METHOD` and the catalog route constant
stay: the inbound `chipswap_directory_v1` handler needs the first, and
`chipswap_trade_propose` still verifies a design against the peer through the
second.

Added:

```motoko
public type DirectoryFoundRequest = { canisters : [Text] };
public type DirectoryFoundResult = {
    #ok : { added : Nat; skipped : Nat; full : Bool; revision : Nat };
    #err : Err;
};

public func /*update*/chipswap_directory_note_found(
    request : DirectoryFoundRequest
) : DirectoryFoundResult
```

A principal that does not parse is counted in `skipped` rather than failing the
batch. The alternative — one bad string discarding a whole crawl — trades a
recoverable partial result for a total loss, and the strings come from peers.

The batch is capped at `MAX_FOUND_BATCH = 512`, the size of the table it writes
into. A larger request is refused with `too_many`; the background chunks to fit.

### 6.4 neutron.json

- `version`: 116 → 117.
- `memory.chipswap.version`: 6 → 7, with the v7 schema and the v6→v7 migration
  declared.
- `preapproved_self_calls`: the three crawl methods out,
  `chipswap_directory_note_found` in.
- `func`: same, with `chipswap_directory_note_found` as a synchronous update.
- The `directory` public-ingress route: `"caller": "canister"` → `"caller": "any"`.

`backend_calls` stays — trades still use it, and so does the catalog check in
`chipswap_trade_propose`.

## 7. Client

### 7.1 `src/wire.ts` — a directory decoder

`decodeDirectoryReply(bytes)` returns `{ entries: string[]; total: number }` or
`null`, reading `TYPE_DIRECTORY = 5`: a `u16` count, that many length-prefixed
principals, then a `u32` total. It refuses a count above
`MAX_DIRECTORY_PAGE = 128`, a principal above `MAX_PRINCIPAL_BYTES = 29`, and
any trailing byte — the same whole-message-or-nothing rule the catalog decoder
follows.

Principal bytes become text through `Principal.fromUint8Array(…).toText()` from
`@dfinity/principal`, already a dependency. Hand-rolling CRC32 and base32 here
would be a second implementation of a thing the agent stack already does
correctly.

`test/fixtures/catalog_wire.json` gains a directory case, generated by
`scripts/gen_wire_fixtures.mo` and read by both the TS and Motoko suites, so the
two decoders cannot drift.

### 7.2 `src/resident/agent.ts` — a second route

The actor, the gateway resolution, the `IngressResult` variant and the
double-Candid unwrap are already there and are route-agnostic. They are lifted
into one `queryRoute(designer, routeId, payload, maximum)` helper;
`fetchCatalog` becomes a caller of it, and `fetchDirectoryPage(designer, offset,
limit)` becomes a second.

The directory request is a Candid record `{ offset : nat; limit : nat }`, unlike
the catalog's empty record, so the payload is encoded per call rather than once.

### 7.3 `src/resident/crawl.ts` — the walk

A pure module: no network, no `querySelf`, no clock beyond what it is handed.
This is the port of what `Directory.mo` deleted, and it is where the behaviour
is tested.

```ts
export type CrawlState = {
  visited: Set<string>;
  cursors: Map<string, number>;
  frontier: Set<string>;   // eligible, not yet visited
  found: Set<string>;      // discovered, not already known to the backend
  queried: number;
  outdated: number;        // peers that refused a browser query
  stopping: boolean;
};
```

- `createCrawl(known: string[], self: string)` seeds the frontier with the
  eligible designers the backend reported.
- `nextTargets(state, limit)` returns up to `limit` targets, part-read peers
  first, so a long directory is finished rather than left behind newer work —
  the ordering rule the Motoko version documented and kept.
- `notePage(state, designer, offset, entries, total)` advances the cursor,
  finishes the peer when the page is short or `total` is reached or
  `MAX_DIRECTORY` is hit, and adds unseen designers to both `frontier` and
  `found`.
- `noteFailure(state, designer, code)` finishes the peer without a strike and
  increments `outdated` when the code is `unauthorized`.

The bounds the Motoko version put on a peer's claimed `total` are kept exactly:
the offset advances only while entries are actually arriving, and stops at
`MAX_DIRECTORY`. A peer claiming four billion entries and handing over one at a
time gets four pages like everyone else.

Self is excluded, and so is any designer the backend already reported —
`found` holds only what is genuinely new, which is what makes the final commit
small.

### 7.4 `src/resident/service.ts` — three tools

| Tool | Input | Output |
| --- | --- | --- |
| `chipswap_crawl_start` | `{}` | the progress snapshot |
| `chipswap_crawl_stop` | `{}` | the progress snapshot after committing |
| `chipswap_crawl_progress` | `{}` | the progress snapshot |

The snapshot is `{ active, queried, remaining, found, outdated, committed,
added, skipped, full, error }`.

`start` refuses a second concurrent crawl, returning the running one's snapshot
rather than an error: two crawls would ask every peer twice.

The loop reads the frontier with `querySelf("chipswap_directory", …)`, paging
until it has the eligible entries, then runs rounds of up to
`MAX_CRAWL_CONCURRENCY = 8` peers — the batch size the deleted backend step
used, kept so a peer sees the same shape of traffic as before.

It publishes on a `crawl` app-state topic after each round, the same nudge
mechanism `CATALOG_TOPIC` uses, so an open tile re-reads rather than polls on a
timer.

The commit runs in a `finally`: normal completion, `stop`, and a thrown error
all reach it, and it is what calls `chipswap_directory_note_found`. A commit that
itself fails is recorded in `error` and the found set is kept in memory, so the
next `start` does not lose it.

### 7.5 `src/api.ts`

`startCrawl`, `crawlStep`, `stopCrawl`, `CrawlProgress` and
`parseCrawlProgress` are removed, along with `crawl` from `parseStatus`.
`noteFoundDesigners(canisters)` is added.

### 7.6 `src/crawl_client.ts`

The tile's side of the three tools, in the shape `src/catalog_client.ts`
already established: `callTool` against `app:<app>:background`, with every
crossing parsed rather than trusted.

### 7.7 `src/views/directory.tsx`

The `runCrawl` loop, the `stopping` ref and the `interrupted` callout come out.
In their place: `startCrawl()` on the button, `stopCrawl()` on Stop, and a
progress line fed by the background — read on mount, so a tile reopened during a
crawl shows it, and refreshed on the app-state nudge.

The completion message gains the two facts the old one could not state:

> Found 40 designers, added 12. Your directory is full.
> 12 of 30 designers are on an older release and could not be asked.

## 8. Testing

**Motoko.** `test/directory.test.mo` loses its crawl cases and gains `noteFound`:
a batch that adds, one that re-adds known designers, one containing self, and
one against a full table asserting `added + skipped` covers the input.
`test/memory_v7.test.mo` and a new leg in `test/memory_migration.test.mo` cover
clean init and v1→v7, with a non-null `crawl` in the v6 fixture to prove the
migration drops it rather than trapping.

**TypeScript.** `test/crawl.test.ts` is the substantial one and is written first:
target ordering, cursor advance, the short-page and `total` stopping rules, a
lying `total`, the `MAX_DIRECTORY` ceiling, self-exclusion, already-known
exclusion, `unauthorized` counted as outdated, and a stop mid-walk committing
what it had.

`test/wire.test.ts` gains directory decoding against the shared fixture plus
rejection cases: bad magic, wrong version, wrong type, an over-long count, a
short buffer, trailing bytes.

`test/package.test.ts` asserts version 117, memory 7, `"caller": "any"` on the
directory route, that the crawl tools are in the background bundle and not the
tile's, and that the three `chipswap_crawl_*` backend methods are gone from the
manifest.

## 9. Out of scope

Catalog fetching and its cache are untouched. Trades are untouched. Nothing
about the served `chipswap_directory_v1` page changes but its caller policy.
Retiring stays driven by paid update calls, where the evidence is honest; a
browser query that goes unanswered still says nothing about whether a designer
is gone.
