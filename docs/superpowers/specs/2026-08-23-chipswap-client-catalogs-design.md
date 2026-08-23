# Chipswap Client-Fetched Catalogs

Status: approved 2026-08-23. Supersedes the catalog-cache portions of
`2026-08-18-chipswap-design.md` §5 and `2026-08-19-chipswap-directory-crawl-design.md`.

Peer catalogs are no longer cached in the Chipswap canister. The browser
queries each peer's `catalog` route directly, keeps what it reads in a
persistent per-installation IndexedDB store, and refreshes any peer whose copy
is older than a day. The canister keeps the directory, the designs, the
holdings, and the trades; it stops keeping other designers' published work.

## 1. Why

`mem.catalog_cache` stores up to `MAX_CATALOG_CACHE` designers' full published
catalogs — title, palette, and 757 pixel indices per design — inside the user's
own canister. That is other people's data, held at the user's storage cost, in
a canister whose purpose is the user's own chips. It also goes stale silently:
a catalog fetched once sits there until something forces a refetch.

Moving the fetch to the browser makes the staleness visible and machine-local,
removes the storage, and removes two backend methods. The cost is a new
resident background process and a TypeScript port of the CSW1 decoder.

## 2. Scope

In scope:

- delete `chipswap_store` and `chipswap_fetch_catalogs`;
- delete `mem.catalog_cache` and the directory fields fed only by it;
- widen the `catalog` public-ingress route to `caller: "any"`;
- add a resident background with persistent browser storage;
- port the CSW1 catalog decoder to TypeScript;
- move market filtering, sorting, paging, and the ownership join to the tile;
- replace the propose-time catalog guard with an inline peer query.

Out of scope: the directory crawl (`chipswap_crawl_*`), which reads the
`directory` route rather than the `catalog` route and writes directory state
the backend legitimately owns; the trade routes; the Studio; the Collection.

## 3. Route policy

`capabilities.public_ingress.routes[catalog]` changes from
`caller: "canister"` to `caller: "any"`.

A tile runs in a credentialless sandboxed iframe and never receives the kernel
frontend's Internet Identity credentials, so a browser-originated query carries
the anonymous principal. `caller: "authenticated"` rejects anonymous callers,
and the only owner-identity path (`callCanisterDialog`) prompts on every call,
which is unusable across a directory of peers. `any` is therefore the only
policy that admits a browser.

The consequence is deliberate: a published catalog becomes readable by anyone
holding the canister id, not only by other Neutron canisters. This extends an
argument the route already makes in `backend/main.mo` — the catalog route is a
query, records nothing about its caller, and charges nothing. What changes is
the size of the audience, not the relationship: browsing still creates no
directory entry and no obligation.

Query routes take no `required_cycles`, so the route's cost profile is
unchanged.

## 4. What the backend loses

### 4.1 Methods

`chipswap_store` and `chipswap_fetch_catalogs` are removed from
`backend/main.mo`, from `neutron.json`'s `func` map, and from
`capabilities.preapproved_self_calls.methods`. `MAX_FETCH_TARGETS` and the
`FetchCatalogsRequest` / `FetchCatalogsResult` / `StoreRequest` / `StorePage` /
`StoreRowView` types go with them.

### 4.2 Directory module

Removed from `backend/Directory.mo`: `storeCatalog`, `storeRows`,
`validFilter`, `cachedDesign`, the `StoreRow` and `StoreFilter` types, the
`ordered` sort helpers, and the catalog-eviction branches in `note`,
`setIgnored`, `setRetired`, and `remove`.

`Directory.reachable` and `noteReachable` stay: the crawl and the trade routes
still use them.

### 4.3 Memory v6

`memory/chipswap/v6.mo` drops:

- `catalog_cache : Map<Principal, CachedCatalog>` and the `CachedCatalog` /
  `CachedDesign` types;
- `design_count : Nat` on `DirectoryEntry`;
- `last_catalog_ns : ?Int` on `DirectoryEntry`.

`memory/chipswap/v5_to_v6.mo` drops the map and the two fields. Nothing is
preserved — the browser refetches — so the migration is a projection with no
fallible step.

`StatusView.catalog_designers` and `DirectoryEntryView.design_count` /
`last_catalog_ns` are removed from the view records in `main.mo`.

## 5. The peer transport in the browser

### 5.1 Two envelopes and a hand-rolled body

A catalog read is three nested formats:

1. **Candid request.** `PublicIngressRequestV1 = { method : text; payload :
   blob }`, where `method` is the route id `"catalog"` — not `protocol:id` —
   and `payload` is Candid for the empty record `PeerCatalogRequest`. Called
   against the physical method
   `physicalPublicIngressMethodName("chipswap", "chipswap_v1", "query")`,
   which resolves to `app_chipswap__chipswap_v1_query`.
2. **Candid reply.** `PublicIngressResultV1 = variant { ok : blob; err :
   variant { … } }`.
3. **CSW1 body.** The `ok` blob is *not* Candid. It is the hand-rolled binary
   format defined in `backend/Wire.mo`.

Layers 1 and 2 use `@dfinity/candid`. Layer 3 needs a new decoder.

### 5.2 `src/wire.ts`

A faithful port of `Wire.decodeCatalogReply` and its readers. The format:

- magic `43 53 57 31` (`CSW1`), then a type byte (`1` for catalog), then the
  version byte, which must equal `3`;
- integers big-endian, `u8`/`u16`/`u32`/`u64`;
- text and blobs `u16`-length-prefixed; principals `u8`-length-prefixed;
- a design is `u16` id, title, art, requirements, flag byte, `u64` revision,
  `u64` timestamp;
- art is shape id text, `u16` palette length, that many `u32` colors, then a
  `u16`-prefixed pixel blob;
- requirements are one flag byte, then only the bytes the flags claim.

The port must reproduce the refusals exactly, because they are what make a
hostile reply safe to parse:

| Condition | Result |
| --- | --- |
| message shorter than 6 bytes or longer than 65,536 | reject |
| magic, type, or version byte mismatch | reject |
| design count above `MAX_DESIGNS` (10) | reject |
| any length prefix above its cap | reject |
| flags byte above `FLAG_KNOWN` (31) | reject |
| `FLAG_NSFW_REQUIRED` set without `FLAG_NSFW_RULE` | reject |
| `min_colors` outside 2..64, `max_coverage` outside 1..99 | reject |
| palette empty or above 64, pixels not exactly 757 bytes | reject |
| any pixel index at or beyond palette size | reject |
| a boolean byte other than 0 or 1 | reject |
| invalid UTF-8 in any text field | reject |
| trailing bytes after the last design | reject |

Every read is bounds-checked and a failed read latches, mirroring the Motoko
`Reader`. A rejected message yields `null`; the caller records the peer as
unreadable and moves on. The decoder never repairs.

Shape validation reuses the constants already in `src/chip.ts`
(`PIXEL_COUNT = 757`, `MAX_PALETTE = 64`, `SHAPE_ID = "circle31"`).

### 5.3 Agent

`@dfinity/agent`'s `HttpAgent`, anonymous identity, `verifyQuerySignatures`
left at its default of on, so replies are checked against the subnet signature
and the root key. Gateway origin `https://icp0.io` for mainnet; the local
gateway and `fetchRootKey` for a development target, selected the way
`apps/wagyu/src/app/service_adapter.ts` selects it.

An anonymous query response is signature-verified but is not certified state.
§8 covers what that permits and why it is acceptable.

## 6. The resident background

### 6.1 Declaration

```json
"background": {
  "path": "service.html",
  "description": "Fetch and cache peer catalogs for the market"
},
"capabilities": {
  "persistent_browser_storage": { "api": 1, "surface": "background" }
}
```

Tiles and trays receive no persistent storage — a tile's credentialless
partition is ephemeral and dies with the top-level page. `persistent_browser_storage`
gives the background an installation-dedicated persistent origin, which is what
lets a catalog fetched today still be there tomorrow. This is a new install-time
capability disclosure.

`public/service.html` sets its own CSP, modelled on
`apps/wagyu/public/service.html`:

```
default-src 'none'; script-src 'self'; connect-src 'self' https://*.icp0.io
http://localhost:* http://*.localhost:*; base-uri 'none'; form-action 'none'
```

`build.ts` gains `service.html`'s script as a second browser entrypoint.

### 6.2 Store

One IndexedDB object store, `catalogs`, keyed by designer principal text:

```ts
type CachedCatalog = {
  designer: string;
  designs: PeerDesign[];   // decoded CSW1 designs
  fetchedAtMs: number;     // 0 if never successfully fetched
  lastError: string | null;
};
```

`fetchedAtMs` is wall-clock milliseconds, not the canister's nanosecond time:
staleness is a question about this machine's clock, and the value never travels
to a peer.

### 6.3 Exposed tools

| Tool | Input | Output |
| --- | --- | --- |
| `chipswap_market_catalogs` | `{}` | every cached entry |
| `chipswap_market_refresh` | `{ designers: string[], force: boolean }` | per-designer fetched / failed |
| `chipswap_market_evict` | `{ designers: string[] }` | count removed |

`force: false` skips any designer whose `fetchedAtMs` is within the TTL.

Refresh runs peers concurrently at `MAX_REFRESH_CONCURRENCY = 8`, the value
`MAX_FETCH_TARGETS` used for the deleted backend batch. Keeping the number
means a peer sees the same shape of traffic after this change as before it,
and a forty-designer directory does not open forty sockets at once.

The tile calls these with `callTool({ target: "app:chipswap:background", … })`.
Same-app tool calls need no owner dialog.

After a refresh changes anything, the background calls `publishAppStateChange`
so an open Market re-reads without polling.

## 7. Staleness

`CATALOG_TTL_MS = 86_400_000` (one day), per designer.

Opening the Market:

1. read every cached catalog and render immediately;
2. compute the refresh set — directory entries that are neither ignored nor
   retired, and whose cache is missing or older than the TTL;
3. if that set is non-empty, call `chipswap_market_refresh` with
   `force: false` and re-render as results land.

A per-designer TTL means adding one designer refetches one designer. A
whole-cache stamp would drag forty peers through a refetch because one was
added, and would make a newly added designer look empty until the next expiry.

The "Refresh catalogs" control calls `chipswap_market_refresh` with
`force: true` over every non-ignored, non-retired directory entry, which
preserves its current meaning: the user asks, every peer is asked now.

Eviction: removing, ignoring, or retiring a directory entry calls
`chipswap_market_evict` for that designer. A peer the user has stopped
following should not leave its catalog on disk.

## 8. Trust

An anonymous query reply is verified against the subnet's signature and the IC
root key, so a boundary node cannot forge one undetected. It is not certified
state, so a peer's own canister remains free to answer a browser differently
than it answers another canister.

The consequence is bounded. A forged or inconsistent catalog can put a row in
the Market that does not correspond to a real published design. It cannot cause
a mint, because §9 verifies the design against the peer through the backend's
own call path before anything is minted or escrowed. The failure mode is a row
that fails when clicked, not a lost chip.

## 9. Propose-time verification

`Trades.beginPropose` loses its `Directory.cachedDesign` gate. The check moves
up into `chipswap_trade_propose`, which is already `async*`:

1. parse and validate the peer principal as today;
2. call the peer's `catalog` route through `callRoute` with
   `QUERY_ROUTE_CYCLES` (zero — it is a query route);
3. decode with `Wire.decodeCatalogReply`;
4. if the reply is absent, undecodable, or contains no design with
   `want_design_id`, return `#err(error("unknown_design"))` — nothing minted,
   nothing escrowed, no paid call made;
5. otherwise proceed into `beginPropose` exactly as today.

This preserves the guard's original reasoning — trading blind would spend a
chip on a design that may not exist — while storing nothing. It also closes a
gap the old guard had: the cache could be arbitrarily old, whereas this reads
the peer's catalog at the moment of the proposal.

The cost is one extra hop on a path that already makes a paid call, and it is
a free hop. A peer that does not answer the query cannot be traded with, which
is correct: the paid trade call to that peer would not have been answered
either.

`restoreOffer` already runs on `#declined` and `#err` in `finishPropose`, so
the rollback path behind this check is unchanged.

## 10. The tile

### 10.1 Market view

`loadStore` is removed from `src/api.ts`. `src/views/market.tsx` assembles its
own page from four sources:

- cached catalogs, via the background;
- the directory, via `loadDirectory` — for ignored/retired filtering, contact
  names, and the designer select;
- holdings, via `loadCollection` — for the `owned` flag;
- own designs, via `loadDesigns` — for the `tradeable` requirement facet.

Filtering, sorting, the `nsfwHidden` tally, and paging all move into
TypeScript. `total` becomes the length of the filtered array rather than a
backend count, which keeps paging honest for the filtered set exactly as the
backend did.

`src/market_filter.ts` keeps its axes, its canonical facet order, and
`filterLabel` unchanged. `serializeFilter` becomes `matchesFilter` — a
predicate builder rather than a wire encoder. `MAX_SEARCH_CHARS` stays as a UI
cap but stops claiming to mirror `backend/Directory.mo`, which will no longer
have a search at all.

The `tradeable` facet needs the requirement evaluation that
`backend/Requirements.mo` performs. `src/requirements.ts` already carries the
matching logic for display; the facet reuses it against the user's holdings
and published designs.

### 10.2 Directory view

`design_count` and `last_catalog_ns` no longer arrive from the backend.
`src/views/directory.tsx` reads them from the background's cache instead:
design count is `designs.length` for that designer, and last-fetched is
`fetchedAtMs`. A designer with no cache entry shows "not fetched" rather than a
zero, which is a true statement where `0` would have been a false one.

The header's "Designers" figure keeps using `status.directoryCount`, which is
unaffected. `status.catalogDesigners` is removed from `src/api.ts`'s `Status`
type and from the summary.

### 10.3 Degraded peers

A peer that rejects the anonymous query — anyone still on a release with
`caller: "canister"` — is recorded with `lastError` and surfaced per-designer
in the Directory as "didn't answer". The Market does not report it inline: a
market that is partly full for a stated reason is better than a banner over
every page. This matters during rollout, when most peers will be on the old
policy.

## 11. Testing

`test/wire.test.ts` is the load-bearing addition. The TypeScript decoder and
the Motoko decoder must agree, so both read shared hex fixtures: a valid
catalog of several designs, an empty catalog, and one fixture per refusal in
§5.2's table. `test/wire.test.mo` is extended with the same fixtures so a
divergence fails on both sides.

Also:

- `test/market_filter.test.ts` and `test/filters_disclosure.test.ts` adapt from
  `serializeFilter` to `matchesFilter`;
- a new `test/market_page.test.ts` covers the client-side filter, sort, tally,
  and paging, porting the cases deleted from `test/directory.test.mo`;
- a new `test/catalog_cache.test.ts` covers TTL selection, eviction, and the
  never-fetched case, as pure functions over a fake clock;
- `test/memory_v6.test.mo` and an extension to `test/memory_migration.test.mo`
  cover the v5→v6 drop;
- `test/main.test.mo` gains propose-verifies-then-mints and
  propose-rejects-without-minting;
- `test/directory.test.mo` loses its store-row cases;
- `test/package.test.ts` asserts the new manifest shape: `catalog` at
  `caller: "any"`, the background declaration, `persistent_browser_storage`,
  the two removed methods absent from `func` and `preapproved_self_calls`, and
  `service.html` present in the package with its CSP.

## 12. Manifest summary

| Field | Change |
| --- | --- |
| `version` | 115 → 116 |
| `background` | added |
| `capabilities.persistent_browser_storage` | added, `surface: "background"` |
| `capabilities.public_ingress.routes[catalog].caller` | `canister` → `any` |
| `capabilities.preapproved_self_calls.methods` | `chipswap_store`, `chipswap_fetch_catalogs` removed |
| `func` | same two removed |
| `memory.chipswap.version` | 5 → 6, schema and migration added |
| `capabilities.backend_calls` | unchanged — crawl and trades still need it |
| `dependencies.contacts` | unchanged |

## 13. Risks

**Rollout.** Until peers upgrade past `caller: "any"`, their catalogs are
unreadable from a browser and their designs vanish from the Market. §10.3 makes
that visible per designer rather than silent. There is no backend fallback by
decision: keeping one would mean keeping the cache this work exists to remove.

**Decoder divergence.** Two implementations of one binary format is the classic
place for a slow drift. Shared fixtures across both test suites (§11) are the
mitigation, and the format is frozen at version 3 with a version byte that
refuses anything else.

**New capability at install.** `persistent_browser_storage` widens what the
app discloses on install. It is the only mechanism that satisfies the caching
requirement, and it stores only peer catalogs that are already public.
