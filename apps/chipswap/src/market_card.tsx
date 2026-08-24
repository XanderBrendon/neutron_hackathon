// One chip in the Market: the artwork, who published it, what it asks of an
// offer, and the two things you can do with it. Lifted out of the market view
// so the card can be rendered and checked on its own, the way the collection's
// card is.

import { formatMsTimestamp, shortPrincipal } from "./api.ts";
import { decodePixels } from "./chip.ts";
import { ChipCanvas } from "./chip_canvas.tsx";
import type { MarketRow } from "./market_page.ts";
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
  return (
    <li className="nt-card chipswap-chip-card">
      <ChipCanvas
        label={`${row.title} by ${shortPrincipal(row.designer)}`}
        palette={row.art.palette}
        pixels={decodePixels(row.art.pixels)}
        scale={4}
      />
      <div className="chipswap-chip-meta">
        <strong>{row.title}</strong>
        <span className="nt-meta" title={row.designer}>
          {row.contactName ?? shortPrincipal(row.designer)}
        </span>
        <PolicyBadges nsfw={row.nsfw} requirements={row.requirements} />
        {row.owned ? <span className="nt-tag nt-tag--success">owned</span> : null}
        {row.ignored ? <span className="nt-tag">ignored</span> : null}
        <span className="nt-meta">seen {formatMsTimestamp(row.fetchedAtMs)}</span>
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
