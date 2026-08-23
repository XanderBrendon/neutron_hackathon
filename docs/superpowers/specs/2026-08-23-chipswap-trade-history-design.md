# Chipswap: trades keep a record

## 1. What changes

A finished trade currently leaves the app in one of two ways depending on which
direction it went, and neither of them is a record.

An outgoing trade that completes stays in `mem.outgoing` carrying
`#completed(ChipRef)`, mixed in with the trades still in flight, until the owner
presses Clear. An incoming trade is deleted outright the moment delivery
succeeds — `completeDelivery` removes the row and nothing takes its place. So
the app can show you an offer you made three weeks ago that you never cleared,
and cannot show you the trade you accepted an hour ago.

After this change both directions settle the same way: the row leaves the live
table and a history entry takes its place. `mem.incoming` and `mem.outgoing`
become tables of work in progress only, and a new `mem.history` holds what
happened — completed, declined in either direction, failed, and unresolved. The
Trades page grows a third panel that shows it, and the owner can forget entries
one at a time or in bulk.

## 2. Why

**A trade is the app's central act and it left no trace.** Chipswap's economics
turn on chips being scarce: offering an acquired chip consumes it, and you must
trade to get it back. The owner had no way to see what they gave up, to whom, or
what they got for it. The chip in `holdings` carries `acquired_at_ns` and a
`ChipRef`, which says what arrived but never what it cost or who it came from.

**The two directions were unequal for no reason.** Outgoing trades survived
because the row doubled as the retry handle for `#uncertain`, and incoming ones
did not because delivery had a clean single point to delete them at. That is an
implementation accident showing through to the owner as a rule.

**The live table was doing two jobs.** `MAX_OUTGOING = 32` is a refusal, not an
eviction (`Trades.mo:160`): propose returns `outgoing_full` when the table is
full. Because finished rows sat in that table until the owner cleared them by
hand, trades the owner had entirely forgotten about could stop them from making
a new one. Separating the record from the work fixes that as a side effect
rather than as a special case.

## 3. Decisions taken

| Question | Decision |
| --- | --- |
| Where a settled trade lives | Moves out of `incoming`/`outgoing` into `history` |
| What an entry stores | A text ledger: titles and `ChipRef`s, no art |
| Which outcomes are recorded | Traded, declined by peer, declined by owner, failed, unresolved |
| A trade that never resolves | The owner may set it aside; it stays resolvable from history |
| The escrowed chip when set aside | Stays `#uncertain`; never released on a guess |
| When history is full | Evicts the oldest; recording a trade can never fail |
| Forgetting | Per entry, plus a bulk clear that skips unresolved rows |
| Existing terminal rows | Migrated into history, not discarded |

### 3.1 Why a text ledger and not art

A history entry stores titles and `ChipRef`s, around 200 bytes, against roughly
1.1KB for a snapshot of a chip's `Art` (757 pixel bytes plus its palette). At
`MAX_HISTORY = 256` that is about 50KB against about 280KB.

The cost was affordable either way — `MAX_HOLDINGS` is 500 chips, so the app
already tolerates half a megabyte of art. The reason to decline it is that a
snapshot is a second copy of something that has an owner elsewhere, and copies
go stale in ways a ledger does not have to reason about. A row names what moved
and when. Where the chip is still held or still published, the page can draw it
from the real thing.

### 3.2 Why `entry_id` and not `request_id`

Request ids cannot key one table across both directions. An inbound request id
is chosen by the peer and is unique only per `(peer, id)` — which is why
`inboundKey` already combines the two — while outbound ids are this canister's
own. A single id space over both would collide.

A monotonic `entry_id` also makes the ordering free: ascending key is
chronological, so newest-first paging is a reverse walk, forgetting one entry is
a `Map.remove`, and evicting the oldest is removing the minimum key.

### 3.3 Why the escrowed chip is not released

`Holdings.mo` states the rule that governs this: an escrowed or uncertain chip
"cannot be offered again, because the peer may already have admitted it." When
the owner sets aside a trade whose outcome was never confirmed, the canister has
learned nothing new — it has only stopped waiting.

Releasing the chip on that non-event would duplicate a unique `ChipRef` into the
world every time the guess was wrong, undetectably and permanently. So the chip
stays `#uncertain`, and the history entry keeps the `peer` and `request_id`
needed to ask again later. Setting a trade aside frees the slot; it does not
decide the trade.

## 4. Schema: memory v9

`v9.mo` is `v8.mo` plus a history store and one subtraction.

```motoko
public type HistoryDirection = { #outgoing; #incoming };
public type HistoryChip = { title : Text; ref : ChipRef };

public type HistoryOutcome = {
    #traded;
    #declined_by_peer : Text;   // we offered, they said no, with their reason
    #declined_by_owner;         // they offered, we said no
    #failed : Text;             // their reply arrived and could not be admitted
    #unresolved;                // never confirmed; the owner set it aside
};

public type HistoryEntry = {
    entry_id : Nat;
    direction : HistoryDirection;
    peer : Principal;
    request_id : Blob;
    want_design_id : Nat;
    ours : ?HistoryChip;        // the chip on our side of the trade
    theirs : ?HistoryChip;      // the chip on their side
    escrow_key : ?Text;         // holdings key, when our side was escrowed
    outcome : HistoryOutcome;
    started_at_ns : Int;
    settled_at_ns : Int;
};
```

`Mem` gains `history : Map.Map<Nat, HistoryEntry>` and `var next_history_id : Nat`.

`ours` and `theirs` name the two sides of the swap rather than the direction of
travel, and `outcome` says whether the chips actually moved. Naming them `gave`
and `got` would have been wrong for exactly the rows this feature exists to
show: an offer we declined moved nothing, so both fields would be null and the
row could not name the chip we turned down. As sides, each field is populated
whenever that side of the trade was ever identified.

Both stay optional because a side can genuinely have no chip: a peer who
declines never mints one, and an offer we refuse is never matched.

`escrow_key` carries `OutgoingTrade.offered_key` across — null when the offer
was minted from one of our own designs. Resolving an unresolved entry later has
to release or consume the escrowed chip, and the holdings key is how it finds
it.

**The subtraction.** `OutgoingState` drops `#completed`, `#declined`, and
`#failed`, leaving `{#sending; #pending_designer; #uncertain}`. Terminal rows
now leave the table at the moment they settle, so those three variants would
describe states that no stored row can be in. A type that can express what
cannot happen is a type that invites handling for it.

## 5. Migration

`v8_to_v9` walks `old.outgoing` and converts every terminal row into a history
entry, keeping only live rows in the table. That data is present and unambiguous:
`#completed(ref)` becomes `#traded`, `#declined(reason)` becomes
`#declined_by_peer(reason)`, `#failed(code)` becomes `#failed(code)`. Entries are
assigned ids in `created_at_ns` order and `next_history_id` starts past them.

Incoming history starts empty. Those rows were deleted on delivery and there is
nothing left to read. Writing plausible rows instead would put trades in the
owner's ledger that this canister cannot show ever happened.

Every other field carries across unchanged, in the retyping style of
`v7_to_v8`: `Map` is invariant in its value type, so `outgoing` must be rebuilt
even where a row is copied verbatim.

## 6. Where records are written

### 6.1 Outgoing: one funnel

`Trades.mo` sets a terminal outgoing state at nine sites (lines 242, 251, 290,
299, 330, 353, 737, 746, and the new set-aside path). Recording at each of them
is how one gets missed. They funnel through a single function that removes the
row and writes the entry as one act:

```motoko
func settleOutgoing(mem, key, trade, theirs : ?HistoryChip, outcome, now)
```

Only `#sending`, `#pending_designer`, and `#uncertain` keep calling
`setOutgoing`. With the terminal variants gone from `OutgoingState`, "terminal
implies recorded implies removed" stops being a convention and becomes the only
thing that compiles.

### 6.2 Incoming: the existing single point

`completeDelivery` (`Trades.mo:572`, called from `main.mo:1202`) is already the
one place a settled inbound row is dropped, and the state it needs is still on
the row: `#accepted` becomes `#traded`, `#declined` becomes `#declined_by_owner`.
The entry is written immediately before the `Map.remove`.

For `#traded`, `ours` is the mint of our own design (`want_design_id` and the
serial recorded in `#accepted`) and `theirs` is the peer's offered chip. For
`#declined_by_owner`, `ours` is null — we never minted — and `theirs` still
names the chip we turned down, which is the whole content of that row.

### 6.3 One visible consequence

A trade with an auto-accepting peer now never appears in "Your offers" — it
settles inside the propose call and lands directly in History. The call already
returns its outcome, so the page can say what happened without the row.

## 7. Retention and forgetting

`MAX_HISTORY = 256`. Recording evicts the minimum key when the table is full, so
writing a record can never fail. Losing the oldest row is the right failure: the
alternative refuses the newest, which is the one the owner is most likely
looking for.

- `forgetHistory(entryId)` removes one entry, unconditionally.
- `clearHistory()` removes every entry **except** `#unresolved` ones, and
  returns the count removed.

The exception is the safety rule. An unresolved entry is the last thing naming a
chip still sitting `#uncertain` in holdings; a bulk clear must not be what
strands it. Forgetting one individually stays allowed — the owner may genuinely
want it gone — with the row saying plainly what it costs.

## 8. Endpoints

**New**

- `chipswap_trade_history(PageRequest) : TradeHistoryPage` — query, newest
  first, using `boundedLimit` exactly as `chipswap_directory` does. Kept out of
  `chipswap_trades` because that call is polled for the pending badge and should
  not carry 256 rows.
- `chipswap_history_forget({ entry_id : Nat }) : RevisionResult`
- `chipswap_history_clear(()) : RevisionResult`
- `chipswap_trade_abandon(TradeRequestRef) : RevisionResult` — valid only on an
  `#uncertain` row. Writes an `#unresolved` entry and drops the row. The chip is
  not touched.

**Kept working by a history lookup**

Dropping the terminal variants removes the `already_final` branch that
`deliverInbound` and `resolveOutgoing` answer a repeat call with. Without a
replacement, a peer retrying a delivery for a trade we have already settled
would get `unknown_trade` and retry forever. Both therefore fall back to
history: a settled entry for that `(peer, request_id)` still answers
`already_final`, so the peer stops.

**Changed**

- `chipswap_trade_resolve` gains a second lookup. If there is no live outgoing
  row but there is an `#unresolved` history entry with that request id, it
  re-runs the status call, rewrites the entry, and settles the chip:
  `Holdings.release` on a declined answer, `Holdings.consume` on a minted one.

**Retired**

- `chipswap_trade_forget`. With no terminal rows left in `outgoing`, it has
  nothing to forget.

Nothing peer-facing moves. `Wire.mo`, `IngressWire.mo`, and all five ingress
routes are untouched: this is a change to what the owner's canister remembers,
not to what it says to anyone else.

## 9. Frontend

`src/views/trades.tsx` gains a third panel below the two that exist.

"Offers waiting on you" is unchanged. "Your offers" loses its Clear button,
since nothing terminal lands there any more, and gains "Give up" beside "Ask the
designer" on an uncertain row.

History is a table — When, With, Gave, Got, Outcome — with "Ask again" on
unresolved rows, "Forget" on every row, and "Forget settled" in the section
header. Twenty-five rows a page behind a "Show more".

`src/api.ts` adds a `TradeHistoryEntry` type with its parser and the four new
calls, drops `forgetTrade`, and shrinks `OutgoingTrade["state"]` to the three
live values.

## 10. Testing

Test-first, per the repository workflow.

- `test/memory_v9.test.mo` — clean initialisation, and a v8 fixture carrying
  both live and terminal outgoing rows: live rows stay in the table, terminal
  rows become history entries in `created_at_ns` order with ids from 1, and
  `next_history_id` lands past the last one.
- `test/trade_history.test.mo` — each of the five outcomes records one entry
  with the right `ours` and `theirs`; a settled entry still answers a repeated
  delivery with `already_final`; eviction at 256 drops the oldest and never
  refuses; `forgetHistory` removes one; `clearHistory` skips unresolved rows;
  abandoning leaves the chip `#uncertain`; resolving from history settles both
  the entry and the chip.
- Extensions to `test/trades.test.mo` and `test/main.test.mo`, which already
  cover the state machine and the endpoints the settle path runs through.
- A frontend test beside `test/chip_save_panel.test.tsx` for the new panel, and
  parser coverage in `test/api.test.ts`.

New Motoko test files are not discovered automatically: `test:motoko` in
`apps/chipswap/package.json` names every file it runs, so `memory_v9.test.mo`
and `trade_history.test.mo` must be added to that list or they will pass by
never running.

Compilation proves the types line up and nothing else. The migration test is the
one that matters, and it needs representative data rather than an empty `Mem`.

## 11. Release

Per `AGENTS.md`:

1. `apps/chipswap/neutron.json`: memory `version` 8 to 9, add the `9` schema
   entry and the `8 -> 9` migration entry, add the new methods to `func` and
   `preapproved_self_calls`, and remove `chipswap_trade_forget` from both.
2. Bump the package `version` from 120 to 121.
3. `npm --workspace neutron-chipswap run package`, plus the app's release tests
   — packaging succeeding does not mean the app's tests ran.

Released schema and migration modules stay immutable: `v8.mo` and every earlier
version are not edited.
