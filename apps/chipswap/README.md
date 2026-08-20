# Chipswap

Design pixel chips, publish up to ten of them, and trade them with other
Neutron canisters.

A chip is a 31 px circle of **757 pixels** — the row widths come from
`Planning/chipswap.md` and are exactly the raster of a circle sampled at pixel
centers. Art is palette-indexed: up to 64 colors plus one index per pixel, so a
whole ten-design catalog crosses the network in about 10 KB.

## How it works

**Ten slots.** A draft occupies one of ten design slots. Deleting a draft frees
its slot; publishing consumes the slot permanently and freezes the artwork.
Only the trade requirements and the NSFW tag stay changeable afterwards,
because those are policy and a label rather than art.

**Trading.** Offering one of your own published designs mints a fresh instance
and costs you nothing. Offering a chip you acquired from someone else consumes
it — you no longer own it and would have to trade for it again.

**Trade requirements.** A design may ask something of the chip offered for it:
a minimum number of colors, a cap on how much of it any one color covers, and
whether the offered chip may or must carry the NSFW tag. An offer that fails a
requirement is declined outright. A fourth requirement, *designer approves*,
does not refuse anything — it holds a qualifying offer in escrow until you
accept or decline it. All four are optional, and a design that asks for nothing
swaps freely in a single call.

Requirements are measured on the receiving side, over the offered art itself,
so a peer cannot assert that its chip has twelve colors: it hands over the
pixels and they are counted. Colors are counted over the pixels rather than
the palette, so padding a palette with swatches nothing paints satisfies
nothing. The tag is the exception — it can only ever be the offering
canister's word about its own art, in the same way the title is. The store runs
the same arithmetic against your own chips before you offer one, so an offer
that would bounce is grayed out with the reason on it rather than costing a
paid call to find out.

**The NSFW tag.** A design may be tagged, and every chip minted from it carries
the tag it was minted with — retagging a design never relabels a chip already
in someone's collection. Tagged chips are left out of the store until you ask
for them, and the store says how many it left out.

**Stamping a picture.** A picture chosen from a file or pasted from the
clipboard is placed under the chip, dragged and scaled against a live preview,
and then sampled: each chip pixel takes the average color of the picture
underneath it, and the picture's colors are reduced by median cut to a budget
that fits the palette. Locked pixels are left out of it — they keep their
color, and their samples take no part in the reduction. Undo takes the stamp
off and hands the picture back at the placement it was stamped from, so a stamp
that came out wrong is nudged and tried again rather than set up afresh.

**Nothing is guessed.** An offer in flight is escrowed rather than deleted. If a
peer never answers, the trade becomes `uncertain` and the chip stays committed
until the `status` route says what actually happened — the app never restores a
chip the other side may already hold.

**Directory.** Nothing arrives in your directory unasked. A designer is there
because you typed their address in, because you added them from Contacts,
because they proposed a trade to you, or because you went looking. Nothing rides
along on ordinary traffic, and there is no way to push yourself into someone
else's list — you enter the graph by trading, and spread from there.

**Finding more designers.** *Find more designers* asks every designer you know
for their directory, a page at a time, then asks whoever that turns up, until
there is nobody left to ask. It runs in rounds so a long crawl shows what it has
done and what it has left, and can be stopped. The route it calls is a query: it
reads, it cannot write, and so a crawl costs the peer nothing, is exempt from
their paid-route rate limits, and leaves no trace — they never learn who was
looking.

**Ignoring a designer.** Ignoring is not forgetting. A forgotten designer comes
straight back the next time a crawl finds them, with no memory of having been
turned away; an ignored one stays in your list saying so. While a designer is
ignored their catalog is never fetched, their cached designs leave the store,
and you stop handing their address to peers who crawl you. Un-ignoring restores
the entry, not the catalog: nothing of theirs reappears until the next refresh
actually fetches something.

**Retired designers.** A designer who uninstalls Chipswap leaves a canister that
no longer answers. The kernel does not tell an app *why* a call was rejected, so
one silent call proves nothing — a canister can be stopped, frozen, or briefly
out of cycles. Three unanswered calls in a row, with any reply at all resetting
the count, mark the designer retired, and a retired one is treated exactly as an
ignored one. Only the paid update routes count: a peer on an older release has
no query dispatcher at all, and must not be retired for having yet to upgrade. A
trade proposal from a retired designer disproves the conclusion and clears it,
and the owner can clear or set it by hand. Chips you already hold from them stay
yours — a chip is copied to you when the trade completes, not fetched later.

**Store.** The store reads a bounded cache of the catalogs you have fetched, so
it opens instantly and refreshes explicitly. It filters by ownership, by
designer ownership, by trade policy, and by the NSFW tag.

## The chipswap_v1 protocol

Five route ids share two public-ingress dispatchers, one per call mode. Four are
updates on `app_chipswap__chipswap_v1_update`, where the sender pays for the work
and storage it asks of a peer. The fifth is a query on
`app_chipswap__chipswap_v1_query`, which writes nothing and therefore declares no
floor and no rate limit. Every route takes a canister caller:

| Route | Mode | Purpose | Cycles floor |
| --- | --- | --- | --- |
| `catalog` | update | fetch a designer's published designs | 300 M |
| `trade` | update | offer a chip and request a design | 600 M |
| `deliver` | update | complete or return a manual trade | 600 M |
| `status` | update | recover the outcome of an uncertain send | 200 M |
| `directory` | query | read one page of a peer's known designers | — |

Requests are ordinary Candid, which the kernel decodes and rejects before app
code runs. Replies are a `Blob` carrying the compact `CSW1` wire, which the
caller parses with bounded byte arithmetic — hostile reply bytes never reach
`from_candid`, which traps.

The wire is at version 3, which removed the directory that used to ride along on
a catalog and a trade and replaced the announce message with a directory message
that is asked for. It is the only version read or written: versions 1 and 2
described the same message types differently, so a reply claiming either is
refused rather than misread, which is what the version byte is for. An install on
version 2 and one on version 3 cannot trade until both update.

Outbound authority is one `method`-scoped reservation for that dispatcher name,
granted at install. It cannot call any other method on any canister, and it
needs no per-designer approval, which is what makes trading with strangers
practical.

## Dependencies

Chipswap declares an install-time dependency on the **Contacts** app
(`contacts_neutron_lookup_v2`, `contacts_neutron_search_v2`) to suggest
designers from the address book and to label peers with their contact names.
Contacts must be installed first, and cannot be uninstalled while Chipswap
remains.

## Build and test

```sh
cd apps/chipswap
npm test              # package + bun tests + Motoko tests
npm run package       # writes chipswap.v0.1.9.neutron
npm run test:motoko   # Motoko unit tests only
```

From the repository root, type-check the app with:

```sh
npx tsc -b apps/chipswap/tsconfig.json
```

`npm run test:motoko:wasi` compiles the same Motoko tests to WASI and runs them
under node. It reports the exact source line of a failed assertion, which the
interpreted runner cannot, but it needs a node build whose WebAssembly limits
accept the generated module.

## Layout

```text
backend/
  Shape.mo          chip geometry and art validation
  Designs.mo        the ten slots: draft, save, publish, mint
  Holdings.mo       chips held, escrowed, or uncertain
  Directory.mo      designers, the crawl, catalog cache, store filtering
  Requirements.mo   measuring an offer against a design's requirements
  Trades.mo         the trade state machine
  Wire.mo           the CSW1 peer reply format
  IngressWire.mo    non-trapping Candid unwrapping
  PrincipalText.mo  non-trapping textual principal parsing
  main.mo           public methods, routes, and outbound drivers
src/
  chip.ts           geometry mirrored from Shape.mo
  palette.ts        colors and blending
  brushes.ts        preset and custom brushes
  patterns.ts       ring, spoke, and grid generators
  flood.ts          the region a fill covers
  image_stamp.ts    sampling a picture down to 757 pixels
  image_source.ts   files and clipboard pictures into a raster
  editor_state.ts   pure editor reducers with undo and locks
  requirements.ts   what a design asks of an offered chip
  api.ts            typed self calls and payload parsers
  views/            studio, collection, store, trades, directory
```

## Not implemented

The forward-looking items in `Planning/chipswap.md` are deliberately absent, and
the design keeps them cheap: purchasable design credits (the slot limit is one
constant over a keyed map), other chip sizes and shapes (art carries a
`shape_id` and the row table is data), and further pattern generators (one table
entry each). Every protocol message carries a wire version, so a v2 message can
arrive without breaking a v1 peer.
