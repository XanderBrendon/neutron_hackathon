// One chip in the collection: the artwork, who it came from, what state it is
// in, and the things you can do with it. Lifted out of the collection view so
// the card can be rendered and checked on its own.

import { cx } from "neutron-design-system";
import {
  formatTimestamp,
  shortPrincipal,
  type Chip,
} from "./api.ts";
import { DIAMETER, decodePixels } from "./chip.ts";
import { ChipCanvas } from "./chip_canvas.tsx";
import { ENLARGED_SCALE, MINIMAL_SCALE } from "./chip_png.ts";

const STATE_LABEL: Record<Chip["state"], string> = {
  held: "Held",
  escrowed: "Offered in a trade",
  uncertain: "Outcome unknown",
};

type Props = {
  chip: Chip;
  busy: boolean;
  onSave: (chip: Chip, scale: number) => void;
  onResolve: (chip: Chip) => void;
};

/** The two offered sizes, named the way they read on the card. */
const DOWNLOADS = [
  { scale: MINIMAL_SCALE, face: "PNG" },
  { scale: ENLARGED_SCALE, face: `PNG ${ENLARGED_SCALE}×` },
] as const;

export const ChipCard = ({ chip, busy, onSave, onResolve }: Props) => {
  // Our own published designs come back in this page too. They are not
  // holdings: there is no serial to show, nobody to credit but us, and no
  // trade to settle.
  const own = chip.origin === "design";
  return (
    <li className="nt-card chipswap-chip-card">
      <ChipCanvas
        label={
          own
            ? `${chip.title}, your design`
            : `${chip.title} by ${shortPrincipal(chip.designer)}`
        }
        palette={chip.art.palette}
        pixels={decodePixels(chip.art.pixels)}
        scale={4}
      />
      <div className="chipswap-chip-meta">
        <strong>{chip.title}</strong>
        <span className="nt-meta">
          {own ? null : <>#{chip.serial} · </>}design {chip.designId}
        </span>
        {chip.nsfw ? <span className="nt-tag nt-tag--warning">NSFW</span> : null}
        {own ? (
          <span className="nt-meta">{chip.mintedCount} minted</span>
        ) : (
          <span className="nt-meta" title={chip.designer}>
            {chip.contactName ?? shortPrincipal(chip.designer)}
          </span>
        )}
        <span className="nt-meta">{formatTimestamp(chip.acquiredAtNs)}</span>
        {own ? (
          <span className="nt-tag">Your design</span>
        ) : (
          <span
            className={cx("nt-tag", {
              "nt-tag--warning": chip.state === "escrowed",
              "nt-tag--danger": chip.state === "uncertain",
            })}
          >
            {STATE_LABEL[chip.state]}
          </span>
        )}
        {chip.state === "uncertain" ? (
          <>
            <p className="nt-help">
              The other Neutron never confirmed this trade. Ask it what happened
              before offering this chip again.
            </p>
            <button
              className="nt-button nt-button--sm"
              disabled={busy}
              onClick={() => onResolve(chip)}
              type="button"
            >
              Ask the designer
            </button>
          </>
        ) : null}
        {chip.state === "escrowed" && chip.peer ? (
          <span className="nt-meta" title={chip.peer}>
            waiting on {shortPrincipal(chip.peer)}
          </span>
        ) : null}
        {/* Offered whatever the chip's state: a chip committed to a trade is
            still yours to keep a picture of. */}
        <div className="chipswap-chip-saves">
          {DOWNLOADS.map(({ scale, face }) => {
            const side = DIAMETER * scale;
            const description = `Save ${chip.title} as a ${side} by ${side} pixel PNG`;
            return (
              <button
                aria-label={description}
                className="nt-button nt-button--ghost nt-button--sm"
                key={scale}
                onClick={() => onSave(chip, scale)}
                title={description}
                type="button"
              >
                {face}
              </button>
            );
          })}
        </div>
      </div>
    </li>
  );
};
