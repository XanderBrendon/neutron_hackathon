# Ignoring a chip in the Market

## The problem

Chipswap can already ignore a *designer*: a standing instruction to stop
fetching their catalog, stop carrying them onward to peers, and drop the copy
this machine had. It is a blunt instrument. A designer whose work you mostly
want, bar the two chips you are tired of seeing, has no smaller gesture
available — you either keep the whole catalog on screen or lose all of it.

So: ignore one chip. The Market stops showing it. A filter shows the chips you
have ignored, so the decision is reviewable and reversible rather than a
one-way door.

## What ignoring a chip is, and is not

Ignoring a chip is a display preference about one design in one designer's
catalog. It withholds a row from the Market grid and nothing else.

It is deliberately weaker than ignoring a designer:

- It does not stop that designer's catalog being fetched. The other nine chips
  are still wanted, so the fetch still has to happen.
- It does not stop the design being traded for. A chip you no longer want to
  *look* at is not a chip you are forbidden to acquire, and the ignored list
  keeps its **Trade for this** button for exactly that reason.
- It says nothing to the designer and nothing to any peer. Nobody but the
  owner ever reads it.
- It is not forgetting. The whole point of the filter is that an ignored chip
  is still there to be found and put back.

## Where the decision lives

In the canister, on the directory entry, as a new memory schema version 10.

`DirectoryEntry` gains one field:

```motoko
ignored_designs : [Nat];   // design ids of this designer's chips, ascending
```

The alternative considered was a memory root of its own, a
`Map<Text, IgnoredDesign>` keyed `"designer.designId"` the way `holdings` is
keyed. It was rejected because every rule this feature needs falls out of the
directory-entry shape for free, and would otherwise be hand-written code that
has to remember to run:

- **Removing a designer removes their ignored chips.** The entry goes; the
  list goes with it. This covers `chipswap_directory_remove` and it also
  covers `Directory.evictOne`, which drops entries on its own when the table
  is full — a separate root would have needed a hook in both, and the second
  one is easy to miss.
- **Ignoring a designer keeps their ignored chips.** `setIgnored` flips a
  flag on the entry and leaves the rest alone, so un-ignoring the designer
  restores exactly the per-chip decisions the owner had made. That is the
  right answer and it required no code.
- **The table cannot outgrow its ceiling.** `MAX_DIRECTORY` is 512 entries and
  a per-designer list is capped at `Wire.MAX_DESIGNS` (10), so the whole
  feature is bounded at 5120 small numbers by construction.
- **It cannot get out of step with what is on screen.** `buildMarketPage`
  builds rows only for designers in the directory, so every chip that *can* be
  ignored already has an entry to hold the decision.

The per-designer cap of 10 is not an arbitrary number: the wire refuses a
catalog carrying more than `MAX_DESIGNS` designs, so ten is the most of one
designer you could ever have been shown, and therefore the most you could ever
have turned away. A cap that real use cannot reach is the point.

`ignored_designs` is kept ascending with no repeats. A set has no order of its
own, so giving it one keeps two equal lists from comparing as different.

### Not a directory seat

`Directory.evictOne` refuses to evict an entry that was chosen by hand, is
ignored, or holds chips. An entry with ignored designs is deliberately **not**
added to that list. A display preference must not be able to pin a directory
seat; the alternative lets ignoring ten chips quietly cost the owner a
designer slot they would rather have spent on a designer.

## Migration v9 → v10

Every directory entry gains `ignored_designs = []`. Everything else passes
through unchanged.

Nobody has ignored a chip before this release, so an empty list is the truth
about every existing entry rather than a default standing in for data that was
lost. Released schemas and migrations are immutable, so v9 and `v8_to_v9` are
untouched and v10 sits beside them.

## The route

```motoko
chipswap_directory_set_design_ignored(
  { canister : Text; design_id : Nat; ignored : Bool }
) : RevisionResult
```

Preapproved, owner-facing, an update, and it bumps the revision so the shell
reloads. Errors:

- `bad_principal` — the text is not a principal.
- `not_found` — no directory entry for that designer. There is nothing to hold
  the decision, and inventing an entry would add a designer the owner never
  asked for.
- `design_invalid` — a design id of 0, or past the `u16` the wire carries one
  in. An id outside what the protocol can express cannot name a real chip.
- `ignore_limit` — the designer's list is already at `Wire.MAX_DESIGNS`.

Setting a flag to what it already is succeeds and changes nothing, so a
double-click is not an error.

`DirectoryEntryView` gains `ignored_designs : [Nat]` for the tile. The
peer-facing page is unaffected: `Directory.served` hands out bare principals
and never a `DirectoryEntry`, so nothing about the owner's preferences can
leave the canister.

## The filter

`MarketFilter` gains `showIgnored : boolean`, default false.

The axis is **exclusive**, not widening — the one place this feature departs
from the `showNsfw` checkbox it otherwise resembles:

- off: ignored chips are withheld from the grid.
- on: the grid shows *only* ignored chips.

That makes the filter a review list. Every card in view carries the same
action, so there is never a question of which button a given card has, and
"go and manage what I have ignored" is one checkbox rather than a hunt through
a mixed grid.

The label names it as **Ignored chips**. Every other axis in `filterLabel`
names what it narrowed to, and this one narrows harder than any of them.

### Precedence against the NSFW tag

Ignoring is applied *before* the tag axis, and the two tallies read
accordingly:

- `ignoredHidden` counts rows that passed every other filter and were withheld
  only for being ignored — tagged ones included.
- `nsfwHidden` counts, as it does today, within what the reader can otherwise
  see: rows the ignore axis let through and the tag axis withheld.

The precedence is deliberate. Ignoring is the owner's own decision about one
specific chip; the tag rule is a blanket. A chip the owner has personally
turned away should not also be reported as withheld for a reason they did not
choose.

The axes stay independent otherwise: a tagged, ignored chip needs both **Show
NSFW** and **Show ignored chips** to appear.

## The card

The Market grid card gains one button beside **Trade for this**:

- an ordinary row: **Ignore**
- a row in the ignored list: **Unignore**, and an `ignored` tag beside the
  `owned` one

Both call the same route with `ignored` set the other way, reload, and let the
revision bump refresh the shell.

## Files

| File | Change |
| --- | --- |
| `backend/memory/chipswap/v10.mo` | new: v9 plus `ignored_designs` on `DirectoryEntry` |
| `backend/memory/chipswap/v9_to_v10.mo` | new: every entry gains an empty list |
| `backend/Directory.mo` | `setDesignIgnored`, `designIgnored`, `MAX_IGNORED_DESIGNS` |
| `backend/{Designs,Holdings,Trades,Requirements,main}.mo` | import v10 |
| `backend/main.mo` | the route, the request type, `DirectoryEntryView.ignored_designs` |
| `neutron.json` | memory 10, schema, migration, method, preapproval, release version |
| `src/market_filter.ts` | `showIgnored` axis, default, label |
| `src/market_page.ts` | `ignoredDesigns` in, `MarketRow.ignored`, `ignoredHidden` out |
| `src/api.ts` | `DirectoryEntry.ignoredDesigns`, `setDesignIgnored` |
| `src/views/market.tsx` | the checkbox, the button, the tallies |

## Testing

Motoko: a `memory_v10` schema test beside the v9 one, a v9→v10 case in
`memory_migration`, and `directory` tests for adding, removing, the cap, the
unknown designer, the ascending order, that removing a designer takes the list
and that ignoring one does not.

Bun: `market_filter` for the new axis and its label, `market_page` for the
exclusive filter and both tallies, `api` for the parser and the call shape,
`package` for the manifest.
