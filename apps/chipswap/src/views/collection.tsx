import { useCallback, useEffect, useState } from "react";
import { cx } from "neutron-design-system";
import {
  errorMessage,
  formatTimestamp,
  loadCollection,
  resolveTrade,
  shortPrincipal,
  type Chip,
  type Status,
} from "../api.ts";
import { ChipCanvas } from "../chip_canvas.tsx";
import { decodePixels } from "../chip.ts";

const PAGE_SIZE = 24;

type Props = {
  status: Status | null;
  onChanged: () => void | Promise<void>;
};

const STATE_LABEL: Record<Chip["state"], string> = {
  held: "Held",
  escrowed: "Offered in a trade",
  uncertain: "Outcome unknown",
};

export const Collection = ({ status, onChanged }: Props) => {
  const [chips, setChips] = useState<Chip[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (nextOffset: number) => {
    try {
      const page = await loadCollection(nextOffset, PAGE_SIZE);
      setChips(page.chips);
      setTotal(page.total);
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void reload(offset);
  }, [offset, reload, status?.revision]);

  const handleResolve = async (chip: Chip) => {
    if (!chip.requestId) return;
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      const outcome = await resolveTrade(chip.requestId);
      setMessage(describeOutcome(outcome.outcome));
      await reload(offset);
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="nt-panel chipswap-collection">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Collection</h2>
        <span className="nt-section-count">
          {total} chip{total === 1 ? "" : "s"}
          {status ? ` · ${status.holdings} of ${status.holdingsLimit} held` : ""}
        </span>
      </header>

      {failure ? (
        <p className="nt-callout nt-callout--danger" role="alert">
          {failure}
        </p>
      ) : null}
      {message ? <p className="nt-callout">{message}</p> : null}

      {chips.length === 0 ? (
        <p className="nt-muted">
          No chips yet. Open the Store to trade for one, or publish a design so
          other people can trade with you.
        </p>
      ) : (
        <ul className="chipswap-grid">
          {chips.map((chip) => {
            // Our own published designs come back in this page too. They are
            // not holdings: there is no serial to show, nobody to credit but
            // us, and no trade to settle.
            const own = chip.origin === "design";
            return (
              <li className="nt-card chipswap-chip-card" key={chip.key}>
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
                  {chip.nsfw ? (
                    <span className="nt-tag nt-tag--warning">NSFW</span>
                  ) : null}
                  {own ? (
                    <span className="nt-meta">{chip.mintedCount} minted</span>
                  ) : (
                    <span className="nt-meta" title={chip.designer}>
                      {chip.contactName ?? shortPrincipal(chip.designer)}
                    </span>
                  )}
                  <span className="nt-meta">
                    {formatTimestamp(chip.acquiredAtNs)}
                  </span>
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
                        The other Neutron never confirmed this trade. Ask it what
                        happened before offering this chip again.
                      </p>
                      <button
                        className="nt-button nt-button--sm"
                        disabled={busy}
                        onClick={() => void handleResolve(chip)}
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
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {total > PAGE_SIZE ? (
        <footer className="nt-pane-footer nt-cluster">
          <button
            className="nt-button nt-button--ghost nt-button--sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            type="button"
          >
            Previous
          </button>
          <span className="nt-meta">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <button
            className="nt-button nt-button--ghost nt-button--sm"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            type="button"
          >
            Next
          </button>
        </footer>
      ) : null}
    </section>
  );
};

function describeOutcome(outcome: string): string {
  switch (outcome) {
    case "completed":
      return "The trade had gone through: the new chip is in your collection.";
    case "declined":
      return "The designer declined. Your chip is available again.";
    case "not_received":
      return "The designer never received the offer. Your chip is available again.";
    case "pending":
      return "The designer still has this offer waiting for a decision.";
    case "uncertain":
      return "The designer could not be reached. The chip stays committed.";
    default:
      return `Outcome: ${outcome}`;
  }
}
