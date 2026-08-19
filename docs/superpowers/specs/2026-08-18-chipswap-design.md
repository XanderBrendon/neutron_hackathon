# Chipswap Design

Status: approved 2026-08-18. Source requirements: `Planning/chipswap.md`.

Chipswap is a Neutron app. Each user installs it into their own Neutron
canister, designs circular pixel "chips", publishes up to ten of them, and
trades chips with other Chipswap canisters. Designers mint unlimited copies of
their own designs; acquired chips are consumed when traded away.

## 1. Scope

This spec covers the complete feature set in `Planning/chipswap.md`:

- the chip editor (palette, blending, brushes, pixel locks, pattern
  generators);
- the ten-slot design lifecycle (draft, publish, immutable art);
- the cross-Neutron trading protocol;
- the designer directory and its exchange rules;
- the chip store and its three filter axes.

Out of scope, deliberately, but not designed against (see §11): purchasable
design credits, chip sizes other than 31 px, chip shapes other than the
circle, further pattern generators.

Also out of scope: publishing to the production update source. This work
produces a packaged, locally installable `chipswap.v0.1.0.neutron` and its
tests. Release publication is a separate maintainer action governed by
`AGENTS.md` and `doc/package-updates.md`.

## 2. Chip geometry

`Planning/chipswap.md` fixes 31 rows with widths

```
9, 13, 17, 19, 21, 23, 25, 27, 27, 29, 29, 31, 31, 31, 31, 31, 31, 31,
31, 31, 29, 29, 27, 27, 25, 23, 21, 19, 17, 13, 9
```

which is exactly the raster of a 31 px circle sampled at pixel centres with
radius `31/2 + eps` for `eps` in `[0.025, 0.055]`. The table is authoritative;
the generator is a cross-check, not the source of truth. Total chip area is
**757 pixels**.

Pixels are indexed 0..756 in row-major order over mask cells only (row 0 left
to right, then row 1, ...). Row `r` starts at the running sum of previous row
widths. Both the Motoko backend and the browser derive that offset table from
the same literal row-width array, and a test asserts the two agree.

A design carries a `shape` descriptor rather than assuming the constant:

```motoko
public type Shape = {
  shape_id : Text;      // "circle31"
  diameter : Nat;       // 31
  row_widths : [Nat];   // the table above
  pixel_count : Nat;    // 757
};
```

Only `circle31` is accepted in v1. Storing the descriptor means a future shape
is a new accepted id, not a memory migration.

## 3. Chip art representation

Palette-indexed art:

```motoko
public type Art = {
  shape_id : Text;
  palette : [Nat32];   // <= 64 entries, 0x00RRGGBB
  pixels : Blob;       // exactly 757 bytes, every byte < palette.size()
};
```

Roughly 1 KB per chip, so a full ten-design catalog fits comfortably inside a
64 KB protocol response. Validation (`Art.validate`) is one shared function
used by the editor save path, the publish path, and every inbound protocol
message: correct shape id, palette size 1..64, `pixels.size() == 757`, and no
index outside the palette. Untrusted art that fails validation is rejected,
never clamped.

## 4. Persistent memory

One managed-memory root, `chipswap`, schema version 1, no migrations.
`backend/memory/chipswap/v1.mo` is immutable after release; it imports only
pinned packages (`mo:core/Map`, `mo:core/List`), never app-local modules.

| Root | Contents | Bound |
|---|---|---|
| `designs` | `Map<Nat, Design>` keyed by slot 1..10 | 10 |
| `holdings` | `Map<Text, Chip>` keyed by `designer.design_id.serial` | 500 |
| `directory` | `Map<Principal, DirectoryEntry>` | 512 |
| `catalog_cache` | `Map<Principal, CachedCatalog>`, LRU by `fetched_at_ns` | 32 designers |
| `incoming` | `Map<Text, IncomingTrade>` keyed by peer+request id | 64 |
| `outgoing` | `Map<Text, OutgoingTrade>` keyed by request id | 32 |
| `replay` | `Map<Text, ReplayRecord>` for inbound idempotency, LRU | 256 |
| `brushes` | `List<CustomBrush>` (7x7 masks) | 16 |

Scalars: `var revision : Nat` (bumps on every owner-visible mutation, used by
the frontend to invalidate), `var next_request_seq : Nat`, `var slots_used`
derived rather than stored.

### 4.1 Design

```motoko
public type DesignState = { #draft; #published };
public type TradeMode  = { #auto; #manual };

public type Design = {
  design_id : Nat;          // 1..10, the slot
  title : Text;             // 1..48 chars after trim
  art : Art;
  state : DesignState;
  trade_mode : TradeMode;
  revision : Nat;           // increments on draft edits; frozen at publish
  created_at_ns : Int;
  published_at_ns : ?Int;
  next_serial : Nat;        // instances minted, starts at 1
};
```

Slot rules, per the approved decision: **a draft occupies one of the ten
slots.** Deleting a draft frees its slot. Publishing consumes the slot
permanently and freezes `title` and `art`; only `trade_mode` stays mutable
afterwards, because it is trading policy rather than artwork. A published
design can never be deleted or edited.

### 4.2 Chip instance

```motoko
public type ChipRef = { designer : Principal; design_id : Nat; serial : Nat };

public type ChipState = {
  #held;
  #escrowed : { request_id : Blob; peer : Principal; since_ns : Int };
  #uncertain : { request_id : Blob; peer : Principal; since_ns : Int };
};

public type Chip = {
  ref : ChipRef;
  title : Text;
  art : Art;
  design_revision : Nat;
  minted_at_ns : Int;
  acquired_at_ns : Int;
  state : ChipState;
};
```

Every chip carries its own art, so a holder can render and re-trade it without
contacting the designer. `designer` doubles as the directory pointer required
by `Planning/chipswap.md` ("chips keep a reference to their designer's
canister").

### 4.3 Directory entry

```motoko
public type DirectorySource = { #manual; #contacts; #trade; #announce; #shared };

public type DirectoryEntry = {
  canister : Principal;
  source : DirectorySource;   // how it first arrived
  first_seen_ns : Int;
  last_seen_ns : Int;
  announced : Bool;           // we have published ourselves to them
  last_catalog_ns : ?Int;
  design_count : Nat;         // from the last catalog fetch
};
```

## 5. Cross-Neutron protocol `chipswap_v1`

One compiler-generated dispatcher, `app_chipswap__chipswap_v1_update`, shared
by five route ids. Every route is `mode: "update"`, `caller: "canister"`,
which means the kernel has already proved a paid inter-canister call before
the handler runs. The caller principal still authenticates the individual
exchange.

| Route id | Handler | Request bytes | Response bytes | `required_cycles` |
|---|---|---|---|---|
| `catalog` | `chipswap_catalog_v1` | 1 024 | 65 536 | 300 000 000 |
| `trade` | `chipswap_trade_v1` | 16 384 | 16 384 | 600 000 000 |
| `deliver` | `chipswap_deliver_v1` | 16 384 | 4 096 | 600 000 000 |
| `status` | `chipswap_status_v1` | 1 024 | 16 384 | 200 000 000 |
| `announce` | `chipswap_announce_v1` | 4 096 | 4 096 | 200 000 000 |

Rate: 240 calls/hour shared per route, plus
`max_calls_per_caller_per_hour: 60` so one hostile peer cannot exhaust the
shared window.

### 5.1 Encoding rule

**Requests are typed Candid.** The kernel decodes the payload into the
handler's declared input type and answers `#bad_request` on malformed bytes,
so handler inputs are already validated structurally when app code runs.

**Responses are `Blob`.** Each handler returns a compact `CSW1` binary
payload. The caller strips two trivially checkable Candid layers — the
`PublicIngressResultV1` `#ok` prefix (byte-for-byte constant, as in
`apps/chess/backend/PublicIngressWire.mo`) and the handler's own `vec nat8`
prefix — then parses the `CSW1` body with bounded byte arithmetic.

This is deliberate. `from_candid` traps on malformed input, and a trap on a
hostile reply would let any peer canister abort our update. Mail uses exactly
this shape; Chess instead hand-writes a 327-line Candid decoder for its reply
type, which we avoid by making the reply a blob in the first place.

`CSW1` framing: magic `43 53 57 31`, `msg_type : u8`, `wire_version : u8`,
then fixed per-message fields. Integers are big-endian; text and blobs are
length-prefixed (`u16`); arrays are count-prefixed (`u16`). Every decoder
enforces a maximum before allocating and rejects trailing bytes.

### 5.2 Messages

`catalog` — request `{ directory : [Principal] }` (<= 32, shared per §6).
Response `#catalog { designs : [WireDesign]; directory : [Principal] }` where
`WireDesign` is `{ design_id, title, art, trade_mode, published_at_ns,
design_revision }` for published designs only. Drafts are never visible.

`trade` — request
`{ request_id : Blob (16); want_design_id : Nat; offered : WireChip;
   directory : [Principal] }`.
Response is one of:

- `#minted { chip : WireChip; directory : [Principal] }` — auto mode
  completed; the reply carries the newly minted instance.
- `#pending { directory : [Principal] }` — manual mode; the designer now
  holds the offered chip in escrow and will call back with `deliver`.
- `#declined { reason : DeclineReason; directory : [Principal] }` — the
  offered chip was *not* retained and the proposer must restore it.
- `#err { code : Text }` for malformed or over-limit requests.

`deliver` — request `{ request_id : Blob; outcome : #minted WireChip |
#returned WireChip | #declined; directory : [Principal] }`. Response
`#ok | #err`. Used by the designer's canister to finish a manual trade.

`status` — request `{ request_id : Blob }`. Response
`#unknown | #pending | #minted WireChip | #declined`. Used only to recover an
uncertain outgoing trade.

`announce` — request `{ directory : [Principal] }`. Response
`#ok { directory : [Principal] }`. Adds the caller to our directory and
returns a directory sample.

### 5.3 Trade state machine

`Planning/chipswap.md` fixes the economics: a designer minting their own
design creates a new instance and loses nothing; trading away an acquired chip
consumes it.

Proposer side (`chipswap_trade_propose`):

1. Validate the target design is in the local catalog cache and that the
   offered chip is either (a) one of our own published designs — minted fresh
   at call time — or (b) a held chip in state `#held`.
2. Allocate `request_id` (16 bytes: 8-byte canister-scoped counter plus 8
   bytes of the current time), and record an `OutgoingTrade` in `#sending`.
3. For case (b), move the offered chip to `#escrowed` **before** the await.
   For case (a) nothing is escrowed; the mint is materialised only on success.
4. `await*` the `trade` route.
5. On `#minted`: consume the escrowed chip (case b) or bump `next_serial`
   (case a), insert the received chip, mark the trade `#completed`.
   On `#pending`: keep the escrow, mark `#pending_designer`.
   On `#declined`: restore the escrowed chip to `#held`, mark `#declined`.
   On broker error or an undecodable reply: mark the trade `#uncertain` and
   move the chip to `#uncertain`. The chip is not silently restored, because
   the designer may have retained it.

`chipswap_trade_resolve` re-queries the `status` route for an `#uncertain`
trade and applies the same terminal transitions, which is the only way an
`#uncertain` chip returns to `#held`.

Designer side (`chipswap_trade_v1`):

1. Reject `caller == self`, unknown/unpublished `want_design_id`, invalid art,
   over-limit directory, or a full holdings/incoming table.
2. Replay: if `(caller, request_id)` is in `replay`, return the stored
   outcome verbatim without re-executing.
3. Merge the sender's directory (§6), then branch on the design's
   `trade_mode`:
   - `#auto` — admit the offered chip to `holdings`, mint the next serial,
     record the outcome, and return `#minted`.
   - `#manual` — store an `IncomingTrade` holding the offered chip in escrow
     and return `#pending`.
4. `chipswap_trade_accept` mints and calls the proposer's `deliver` route with
   `#minted`, then admits the escrowed chip to `holdings`.
   `chipswap_trade_decline` calls `deliver` with `#returned` carrying the
   original chip and drops the escrow. Both are idempotent against the
   `IncomingTrade` state.

Recipient of `deliver`: match `request_id` against `outgoing`, verify the
caller is that trade's peer, then complete or restore exactly as in step 5.

### 5.4 Cycle authority

```json
"backend_calls": {
  "api": 1,
  "reservation_scopes": ["method"],
  "install_reservations": [
    { "kind": "method", "method": "app_chipswap__chipswap_v1_update" }
  ],
  "max_concurrency": 8,
  "max_cycles_per_call": 600000000,
  "max_cycles_per_day": 2400000000000
}
```

The `method` scope grants "this one method name on any non-system principal",
which is what a trading network needs: no per-designer approval click. It is
also the narrowest scope that supports the feature — it cannot call any other
method on any canister. Mail uses the identical pattern.

`chipswap_fetch_catalogs` uses `call_batch` with at most 8 targets per call,
matching `max_concurrency`.

## 6. Directory

Three ways a canister enters the directory:

1. **Manual** — the owner pastes a principal in the Directory view. The view
   also shows this Neutron's own canister id with a copy button.
2. **Contacts** — `contacts_neutron_search_v2` lists address-book entries that
   carry a Neutron principal; each row has an "Add" action.
   `contacts_neutron_lookup_v2` labels directory and store rows with the
   contact name when one exists.
3. **Exchange** — every `trade` request and response, and every `announce`,
   carries up to 32 principals. Receiving a principal we have not seen adds it
   with source `#shared`.

Per `Planning/chipswap.md`, learning about a new designer does *not*
automatically publish us to them. Newly learned entries surface in the
Directory view with an "Announce me" action that calls the `announce` route
and sets `announced = true`. A settings toggle, default off, can announce
automatically on discovery.

Directory eviction at the 512 bound drops the least recently seen entry that
we hold no chip from and have not announced to.

## 7. Store

`chipswap_store` reads only `catalog_cache`, so the view renders instantly and
refresh is explicit. `chipswap_fetch_catalogs([Principal])` refreshes up to 8
designers per call; the frontend paginates over the directory and shows
progress.

The three filter axes from the requirements are applied in the backend query
so paging stays correct:

- ownership: `all` | `owned` | `not_owned` (do we hold any instance of this
  design);
- designer ownership: `all` | `owner_of_designer` | `not_owner_of_designer`
  (do we hold any chip by this designer);
- trade mode: `all` | `auto` | `manual`.

Cache entries older than a configurable freshness window are shown with a
"stale" marker rather than hidden, because a designer canister may be
unreachable.

## 8. Owner-facing backend methods

All are `preapproved_self_calls`, so the tile calls them without a dialog.

Queries: `chipswap_status`, `chipswap_designs`, `chipswap_design`,
`chipswap_collection`, `chipswap_directory`, `chipswap_contacts_suggestions`,
`chipswap_trades`, `chipswap_store`, `chipswap_brushes`.

Updates: `chipswap_draft_create`, `chipswap_draft_save`,
`chipswap_draft_delete`, `chipswap_publish`, `chipswap_set_trade_mode`,
`chipswap_directory_add`, `chipswap_directory_remove`, `chipswap_brush_save`,
`chipswap_brush_delete`, and the `async*` protocol drivers
`chipswap_announce`, `chipswap_fetch_catalogs`, `chipswap_trade_propose`,
`chipswap_trade_resolve`, `chipswap_trade_accept`, `chipswap_trade_decline`.

Every mutating method takes an `expected_revision` where a conflicting
concurrent edit is possible (draft save, publish, trade actions) and returns a
`#revision_conflict` error carrying the current revision rather than
overwriting.

## 9. Frontend

One tile, five views, shared header showing slot usage, holdings count, and
pending-trade badge.

**Studio.** Canvas-rendered 757-pixel mask at an integer scale that fits the
tile, pointer-drag painting, undo/redo over a bounded diff stack. Editor state
lives in typed arrays (`Uint8Array(757)` indices, `Uint8Array(757)` locks);
saving serialises to the wire art format.

- *Palette*: swatch strip, add via `<input type="color">`, remove unused,
  and a blend control that takes two swatches plus a ratio and appends the
  interpolated colour.
- *Brushes*: presets 1x1, 2x2, 3x3, cross, X, L, plus a 7x7 custom brush
  editor whose results persist in `brushes`. A brush is a mask plus an anchor.
- *Locks*: paint locks with the current brush, lock every pixel of a chosen
  colour, unlock all. Locked pixels render a hatch overlay and are skipped by
  *every* mutation including generators.
- *Generators*: concentric rings, spokes, and pixel grid, ported from
  `Planning/circle-bench_1.html`. Each takes parameters (band count, colour
  selection, rotation/phase) and renders a live preview committed by an
  explicit Apply. Generators are table-driven so a fourth is one entry.

**Collection.** Held chips with designer label, serial, and state; escrowed
and uncertain chips are visually distinct with a Resolve action.

**Store.** Filtered grid of cached catalog designs with a Trade action that
opens the offer picker (own designs first, marked "mints a new copy"; held
chips marked "you will lose this chip").

**Trades.** Incoming pending trades with Accept/Decline, outgoing trades with
state and Resolve for uncertain ones.

**Directory.** Own canister id with copy, manual add, Contacts suggestions,
per-entry Announce and Refresh catalog.

Styling imports `neutron-design-system/styles.scss` under the documented
`@layer` order with app-prefixed classes, dark-only, no gradients, radii <=
5 px.

## 10. Testing

Fast tests only, per the approved decision.

- `test/package.test.ts` — manifest validates; id/version/update_source;
  the five routes with exact modes, callers, byte caps and cycle floors;
  `backend_calls` scope and install reservation; the Contacts dependency;
  tile metadata; every declared `func` present in the backend; generated
  method schemas usable through icblast; bundled CSS carries the design-system
  assertions used by the other apps.
- `test/memory_release.test.mo` — schema `init()`, every root reachable,
  bounds constants sane.
- `test/wire.test.mo` — `CSW1` round-trips for all five responses, plus
  rejection of truncated, over-long, wrong-magic, and trailing-byte inputs.
- `test/trade.test.mo` — the state machine: auto mint, manual pending then
  accept, decline restores, replay returns the stored outcome, uncertain then
  resolve, self-trade rejected, bounds enforced.
- Bun tests — mask geometry against the literal row table, pixel offset
  agreement with the Motoko table, generator output determinism, brush
  stamping and anchoring, lock enforcement, palette blend maths, art
  validation, store filter logic, and the frontend API parsers.
- `npm --workspace neutron-chipswap run package` must succeed and emit
  `chipswap.v0.1.0.neutron`.

## 11. Forward compatibility

The future items in `Planning/chipswap.md` are not implemented, and the
following choices keep them cheap:

- **More design credits** — the slot limit is a single constant checked in one
  place, and `designs` is a map keyed by slot rather than a fixed array.
- **More sizes / shapes** — art carries a `shape_id` and the row table is data,
  not a constant baked into the pixel loops. A new shape is a new accepted id
  plus a new row table; stored art stays valid.
- **More generators** — generators are a parameterised table in one module.
- The protocol carries `wire_version` in every message, and unknown message
  types decode to a clean rejection rather than a trap, so a v2 message can be
  added without breaking v1 peers.

## 12. Risks

- **Contacts is a required dependency.** Chipswap cannot install without it,
  and Contacts cannot be uninstalled while Chipswap remains. Accepted
  deliberately for the Contacts-backed discovery flow.
- **Manual-mode escrow depends on the designer acting.** An offered chip can
  sit in escrow indefinitely. v1 exposes the state honestly in the Collection
  view and offers `status`-based resolution; it does not auto-expire escrow,
  because expiry without designer agreement would duplicate a chip.
- **A lost reply is genuinely ambiguous.** The design never guesses: an
  uncertain trade stays uncertain until `status` answers.
