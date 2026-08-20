# Chipswap

Design pixel chips, publish up to ten of them, and trade them with other
Neutron canisters.

A chip is a 31 px circle of **757 pixels** — the row widths come from
`Planning/chipswap.md` and are exactly the raster of a circle sampled at pixel
centres. Art is palette-indexed: up to 64 colours plus one index per pixel, so a
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
a minimum number of colours, a cap on how much of it any one colour covers, and
whether the offered chip may or must carry the NSFW tag. An offer that fails a
requirement is declined outright. A fourth requirement, *designer approves*,
does not refuse anything — it holds a qualifying offer in escrow until you
accept or decline it. All four are optional, and a design that asks for nothing
swaps freely in a single call.

Requirements are measured on the receiving side, over the offered art itself,
so a peer cannot assert that its chip has twelve colours: it hands over the
pixels and they are counted. Colours are counted over the pixels rather than
the palette, so padding a palette with swatches nothing paints satisfies
nothing. The tag is the exception — it can only ever be the offering
canister's word about its own art, in the same way the title is. The store runs
the same arithmetic against your own chips before you offer one, so an offer
that would bounce is greyed out with the reason on it rather than costing a
paid call to find out.

**The NSFW tag.** A design may be tagged, and every chip minted from it carries
the tag it was minted with — retagging a design never relabels a chip already
in someone's collection. Tagged chips are left out of the store until you ask
for them, and the store says how many it left out.

**Stamping a picture.** A picture chosen from a file or pasted from the
clipboard is placed under the chip, dragged and scaled against a live preview,
and then sampled: each chip pixel takes the average colour of the picture
underneath it, and the picture's colours are reduced by median cut to a budget
that fits the palette. Locked pixels are left out of it — they keep their
colour, and their samples take no part in the reduction. Undo takes the stamp
off and hands the picture back at the placement it was stamped from, so a stamp
that came out wrong is nudged and tried again rather than set up afresh.

**Nothing is guessed.** An offer in flight is escrowed rather than deleted. If a
peer never answers, the trade becomes `uncertain` and the chip stays committed
until the `status` route says what actually happened — the app never restores a
chip the other side may already hold.

**Directory.** Every trade carries up to 32 designer addresses in each
direction, so trading is also how you discover new designers. Learning about
someone does *not* publish you to them: `announce` is a separate choice, with an
optional setting that announces automatically while you refresh catalogs.
Contacts entries carrying a Neutron address can be added directly.

**Store.** The store reads a bounded cache of the catalogs you have fetched, so
it opens instantly and refreshes explicitly. It filters by ownership, by
designer ownership, by trade policy, and by the NSFW tag.

## The chipswap_v1 protocol

Five route ids share one paid public-ingress dispatcher,
`app_chipswap__chipswap_v1_update`. Every route is an update from a canister
caller, and the sender pays:

| Route | Purpose | Cycles floor |
| --- | --- | --- |
| `catalog` | fetch a designer's published designs | 300 M |
| `trade` | offer a chip and request a design | 600 M |
| `deliver` | complete or return a manual trade | 600 M |
| `status` | recover the outcome of an uncertain send | 200 M |
| `announce` | publish yourself into a peer's directory | 200 M |

Requests are ordinary Candid, which the kernel decodes and rejects before app
code runs. Replies are a `Blob` carrying the compact `CSW1` wire, which the
caller parses with bounded byte arithmetic — hostile reply bytes never reach
`from_candid`, which traps.

The wire is at version 2, which added trade requirements to a catalog entry and
the NSFW tag to a chip. Version 1 replies still decode — their trade mode
becomes the one requirement it stood for, and their chips arrive untagged — but
we only ever write version 2, which a version 1 peer refuses outright rather
than misreading.

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
npm run package       # writes chipswap.v0.1.5.neutron
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
  Directory.mo      designers, catalog cache, store filtering
  Requirements.mo   measuring an offer against a design's requirements
  Trades.mo         the trade state machine
  Wire.mo           the CSW1 peer reply format
  IngressWire.mo    non-trapping Candid unwrapping
  PrincipalText.mo  non-trapping textual principal parsing
  main.mo           public methods, routes, and outbound drivers
src/
  chip.ts           geometry mirrored from Shape.mo
  palette.ts        colours and blending
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
