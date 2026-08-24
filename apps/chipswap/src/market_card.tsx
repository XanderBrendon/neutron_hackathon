// One chip in the Market: the artwork, who published it, what it asks of an
// offer, and the two things you can do with it. Lifted out of the market view
// so the card can be rendered and checked on its own, the way the collection's
// card is.

import { formatMsTimestamp, shortPrincipal } from "./api.ts";
import { decodePixels } from "./chip.ts";
import { ChipCanvas } from "./chip_canvas.tsx";
import type { MarketRow } from "./market_page.ts";
import { describe as describeRequirements } from "./requirements.ts";
import { PolicyBadges } from "./trade_policy.tsx";

type Props = {
  row: MarketRow;
  busy: boolean;
  onTrade: (row: MarketRow) => void;
  /** Turn the chip away, or take it back off the list. */
  onSetIgnored: (row: MarketRow, ignored: boolean) => void;
};

export const MarketCard = ({ row, busy, onTrade, onSetIgnored }: Props) => {
  // Ignoring withholds this chip from the Market and nothing else: the designer
  // is still fetched from, because the rest of their catalog is still wanted,
  // and the chip is still tradeable, because one you would rather not look at
  // is not one you are forbidden to acquire. So the trade stays on the card
  // whichever way this reads.
  const ignore = row.ignored
    ? { face: "Unignore", description: `Unignore ${row.title}` }
    : { face: "Ignore", description: `Ignore ${row.title}` };
  const seen = formatMsTimestamp(row.fetchedAtMs);
  // Every line the card holds to a set height carries its full text in a title,
  // so nothing the tile trims is lost — it is a hover away.
  const source = row.contactName
    ? `${row.contactName} · ${row.designer}`
    : row.designer;
  // The badges are the policy at a glance and the band holds four rows of
  // them; this is the whole of it in words, for the design that asks for more
  // than that. The offer dialog says the same thing at length once you get
  // there.
  const asks = describeRequirements(row.requirements);
  const policy = [
    row.nsfw ? "Tagged NSFW." : null,
    asks.length === 0
      ? "Swaps freely: asks for nothing in particular."
      : `Asks for ${asks.join(", ")}.`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <li className="nt-card chipswap-chip-card chipswap-market-card">
      <ChipCanvas
        label={`${row.title} by ${shortPrincipal(row.designer)}`}
        palette={row.art.palette}
        pixels={decodePixels(row.art.pixels)}
        scale={4}
      />
      <div className="chipswap-chip-meta">
        <strong className="chipswap-chip-title" title={row.title}>
          {row.title}
        </strong>
        <span className="nt-meta chipswap-chip-source" title={source}>
          {row.contactName ?? shortPrincipal(row.designer)}
        </span>
        {/* A tile whose height follows the policy would make a demanding chip
            a taller card than an open one, and the grid a ragged thing with
            its buttons on no shared line. The policy gets a fixed band of the
            card instead, and the rare design that asks for more than fits
            scrolls inside it rather than pushing everything below it down. */}
        <div className="chipswap-chip-requirements" title={policy}>
          <PolicyBadges nsfw={row.nsfw} requirements={row.requirements} />
        </div>
        {/* Held open whether or not there is a tag to put in it, for the same
            reason: an empty line here is what keeps this card the height of
            the one beside it. */}
        <div className="chipswap-chip-tags">
          {row.owned ? <span className="nt-tag nt-tag--success">owned</span> : null}
          {row.ignored ? <span className="nt-tag">ignored</span> : null}
        </div>
        <span className="nt-meta chipswap-chip-seen" title={seen}>
          seen {seen}
        </span>
        <div className="chipswap-chip-actions">
          <button
            className="nt-button nt-button--sm"
            disabled={busy}
            onClick={() => onTrade(row)}
            type="button"
          >
            Trade for this
          </button>
          {/* A grid of cards is a row of identical buttons to a screen reader,
              so the label names the chip rather than only the action. */}
          <button
            aria-label={ignore.description}
            className="nt-button nt-button--ghost nt-button--sm"
            disabled={busy}
            onClick={() => onSetIgnored(row, !row.ignored)}
            title={ignore.description}
            type="button"
          >
            {ignore.face}
          </button>
        </div>
      </div>
    </li>
  );
};
