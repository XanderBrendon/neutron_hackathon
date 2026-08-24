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
canister's word about its own art, in the same way the title is. The Market
runs the same arithmetic against your own chips before you offer one, so an
offer that would bounce is grayed out with the reason on it rather than costing
a paid call to find out.

**The NSFW tag.** A design may be tagged, and every chip minted from it carries
the tag it was minted with — retagging a design never relabels a chip already
in someone's collection. Tagged chips are left out of the Market until you ask
for them, and the Market says how many it left out.

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

**Directory.** Nothing arrives in your directory unasked, bar the single entry
named below. A designer is there because you typed their address in, because you
added them from Contacts, because they proposed a trade to you, or because you
went looking. Nothing rides along on ordinary traffic, and there is no way to
push yourself into someone else's list — you enter the graph by trading, and
spread from there.

**The one you start with.** Every route to a new designer needs a designer you
already know: a catalog is fetched from someone in your list, a crawl asks the
people in your list who *they* know, and a trade needs a design you can already
see. An empty directory is therefore a dead end, so a new install begins with
one address — `3wvx3-yaaaa-aaaay-aacuq-cai` — tagged `seed` to say plainly that
you did not choose it. From there the graph is reachable. Remove it, ignore it,
or trade with it; it is an ordinary entry in every respect, and it is the only
one Chipswap ever puts in your list on your behalf. Upgrading an existing
install adds nothing: the seed is what a directory starts as, not a correction
applied to one you have already made your own.

**Finding more designers.** *Find more designers* asks every designer you know
for their directory, a page at a time, then asks whoever that turns up, until
there is nobody left to ask. The route it calls is a query: it reads, it cannot
write, and so a crawl costs the peer nothing, is exempt from their paid-route
rate limits, and leaves no trace — they never learn who was looking.

The walk runs in your browser, not in your canister. It asks the peers directly,
anonymously, and keeps everything about its own progress in memory that dies
with the process: how far it has got, which peers are part-read, which are
finished. Your canister hears about it once, at the end — a single call carrying
the designers that were found, sent whether the crawl completed, you stopped it,
or it failed part-way. That is the whole of what a crawl is worth keeping, and
the rest was costing you an inter-canister call per peer for data anyone can
read for free.

Because the walk is a browser now, a peer still on an older release refuses the
query outright — they only opened that route to canisters. Those are counted and
named when the crawl ends, so a thin result says *why* it was thin rather than
implying an empty network. Nothing is concluded about them for it: not having
upgraded is not the same as being gone.

Your directory holds 512 designers. A crawl fills the seats that are free and
never evicts to make more, so the number it reports as added is the number your
directory actually gained — if it found forty and could seat twelve, it says
so.

**Ignoring a designer.** Ignoring is not forgetting. A forgotten designer comes
straight back the next time a crawl finds them, with no memory of having been
turned away; an ignored one stays in your list saying so, and the crawl is told
to leave them out of both the walk and what it brings home. While a designer is
ignored their catalog is never fetched, the copy this machine already had is
dropped, and you stop handing their address to peers who crawl you. Un-ignoring
restores the entry, not the catalog: nothing of theirs reappears until the next
refresh actually fetches something.

**Ignoring a chip.** Ignoring a designer is a blunt instrument: a designer
whose work you mostly want, bar the two chips you are tired of seeing, leaves
you choosing between the whole catalog and none of it. So a single chip can be
turned away instead. **Ignore** on a Market card withholds that chip from the
grid, and the Market says how many it left out — the same disclosure the NSFW
tally makes, and for the same reason.

It is deliberately weaker than ignoring the designer. Their catalog is still
fetched, because the other chips are still wanted. The design is still tradeable,
because a chip you would rather not look at is not one you are forbidden to
acquire, so **Trade for this** stays on the card. And nobody but you ever reads
it: it lives on your directory entry for that designer, and what a crawling peer
reads from you is bare addresses.

It is also not forgetting. *Show ignored chips* turns the Market into the list of
what you have turned away, each card offering **Unignore** in place of the button
that put it there. Removing a designer takes their ignored chips with them;
ignoring the designer does not, so un-ignoring them restores the decisions you
had already made rather than a blank list to make again.

**Designers who stop answering.** A designer who uninstalls Chipswap leaves a
canister that no longer answers, and nothing tells you which of those has
happened. The kernel does not say *why* a call was rejected, so silence proves
nothing on its own: a canister can be stopped, frozen, briefly out of cycles, or
simply on a release that cannot answer the route you asked.

So Chipswap concludes nothing from it. It used to — three unanswered paid calls
marked a designer *retired*, and a retired one was treated as an ignored one —
and the flag was wrong in both directions. It silenced canisters that were down
for an afternoon, and it stayed clear for canisters long gone that you had not
happened to trade with. Worse, the reader that actually notices a dead designer
was forbidden from touching it: a catalog read is a query, and a peer who has
merely not upgraded refuses a query too.

What happens instead is that the Market shows you. When it refreshes catalogs,
every designer that came back with nothing is named above the grid, with what
went wrong beside them and two buttons: **Ignore**, which is the standing
instruction below, and **Remove**, which drops them from your directory
entirely. Both take their cached catalog with them. Doing neither is a decision
too — their chips stay on display from the last time they answered, and the
notice goes away by itself the moment they answer again.

Chips you already hold from them stay yours either way: a chip is copied to you
when the trade completes, not fetched later.

**Market.** Catalogs are read by the browser, from the designers that publish
them, and kept on the machine that asked. The canister stores none of them: a
peer's published work is theirs, it is public, and holding a copy of it in your
own canister costs you storage for data that goes stale silently.

The Market therefore opens on whatever this machine last fetched — instantly,
with no network in the way — and then re-asks any designer whose copy is more
than a day old, filling rows in behind you as they answer. Filtering, sorting
and paging all happen in the browser over that copy.

A designer who does not answer keeps the catalog they last gave you rather than
emptying out, and is named above the grid with what went wrong and the choice of
ignoring or removing them. That naming matters during a rollout: the `catalog`
route only became readable by a browser in version 116, so a designer still on
an older release cannot be read from here until they upgrade — and being told
*that*, rather than that they did not answer, is the difference between waiting
for them and dropping them.

Two choices sit above the filters because they are standing ones: *Show NSFW*,
which is off until you turn it on, and *Refresh catalogs*. Everything else is
in a collapsed **Filters** section — a title search, a designer, a sort order,
*Hide chips I already own*, *Show ignored chips*, and the trade requirements.

*Show ignored chips* is the one filter that replaces the set rather than
trimming it: asked for, the Market is the chips you have turned away and nothing
else. That makes it a list to review, where every card carries the same action,
rather than a grid to search through for the ones that read differently. It is
independent of the tag rule, so a chip that is both tagged and ignored needs
both asked for.

The requirement boxes widen each other rather than narrowing: ticking two shows
the designs matching either. *Trades I can make* is the one that reads your own
side of the swap — it measures every chip you hold and every design you have
published against each listing's requirements, and keeps the listings at least
one of them satisfies. It counts a design that asks for the designer's approval,
because approval decides what becomes of an offer that already qualifies rather
than whether it qualifies; it does not count a draft, which cannot be offered,
or a chip already escrowed in a trade in flight.

Filtering, sorting and paging all happen in the browser, over the copy this
machine holds, so the count the header gives is the count for the filter you
asked for rather than for the page you can see.

## The chipswap_v1 protocol

Five route ids share two public-ingress dispatchers, one per call mode. Three
are updates on `app_chipswap__chipswap_v1_update`, where the sender pays for the
work and storage it asks of a peer. The other two are queries on
`app_chipswap__chipswap_v1_query`, which write nothing and therefore declare no
floor and no rate limit — the kernel permits a query route neither. The three
that change a peer's state are the three that cost something, which is the whole
rule. Every route takes a canister caller:

| Route | Mode | Purpose | Cycles floor |
| --- | --- | --- | --- |
| `trade` | update | offer a chip and request a design | 600 M |
| `deliver` | update | complete or return a manual trade | 600 M |
| `status` | update | recover the outcome of an uncertain send | 200 M |
| `catalog` | query | fetch a designer's published designs | — |
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
  Directory.mo      designers, and what a crawl brings back
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
  market_filter.ts  the market's filter axes and how they are named
  market_card.tsx   one chip in the market: what it says and what it offers
  catalog_failure.ts which designers did not answer, and what to say about it
  market_page.ts    the market page, joined and filtered in the tile
  wire.ts           the CSW1 catalog and directory readers, mirroring Wire.mo
  catalog_client.ts the tile's side of the background's catalog tools
  crawl_client.ts   the tile's side of the background's crawl tools
  api.ts            typed self calls and payload parsers
  resident/
    service.ts      the background: exposes the catalog and crawl tools
    agent.ts        anonymous queries to a peer's catalog and directory
    store.ts        the IndexedDB catalog cache
    freshness.ts    which designers are worth asking again
    crawl.ts        the walk: frontier, cursors, and what may be adopted
    crawl_run.ts    rounds of peer queries, then one commit to the backend
  views/            studio, collection, market, trades, directory
```

The `catalog` and `directory` routes admit any caller, because a tile is
credentialless and never holds the owner's identity — a browser-originated query
is anonymous or it does not happen. Replies are signature-verified against the IC root key, but
they are not certified state, so nothing read this way is trusted enough to
spend a chip on: `chipswap_trade_propose` re-asks the peer through the backend
before it mints or escrows anything.

## Not implemented

The forward-looking items in `Planning/chipswap.md` are deliberately absent, and
the design keeps them cheap: purchasable design credits (the slot limit is one
constant over a keyed map), other chip sizes and shapes (art carries a
`shape_id` and the row table is data), and further pattern generators (one table
entry each). Every protocol message carries a wire version, so a v2 message can
arrive without breaking a v1 peer.
