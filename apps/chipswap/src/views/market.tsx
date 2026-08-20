import { useCallback, useEffect, useMemo, useState } from "react";
import { cx } from "neutron-design-system";
import {
  errorMessage,
  fetchCatalogs,
  formatTimestamp,
  loadCollection,
  loadDesigns,
  loadDirectory,
  loadStore,
  proposeTrade,
  shortPrincipal,
  type Chip,
  type Design,
  type Status,
  type StoreFilter,
  type StoreRow,
} from "../api.ts";
import { ChipCanvas } from "../chip_canvas.tsx";
import { decodePixels } from "../chip.ts";
import {
  DESIGNER_OPTIONS,
  NSFW_OPTIONS,
  OWNERSHIP_OPTIONS,
  POLICY_OPTIONS,
  defaultFilter,
  filterLabel,
} from "../store_filter.ts";
import { PolicyBadges } from "../trade_policy.tsx";
import {
  check,
  describe as describeRequirements,
  failureMessage,
  measure,
  type FailureCode,
} from "../requirements.ts";

const PAGE_SIZE = 24;
const BATCH = 8;

type Props = {
  status: Status | null;
  onChanged: () => void | Promise<void>;
};

export const Store = ({ status, onChanged }: Props) => {
  const [filter, setFilter] = useState<StoreFilter>(defaultFilter());
  const [rows, setRows] = useState<StoreRow[]>([]);
  const [total, setTotal] = useState(0);
  const [nsfwHidden, setNsfwHidden] = useState(0);
  const [offset, setOffset] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offerFor, setOfferFor] = useState<StoreRow | null>(null);
  const [ownDesigns, setOwnDesigns] = useState<Design[]>([]);
  const [heldChips, setHeldChips] = useState<Chip[]>([]);

  const reload = useCallback(
    async (nextFilter: StoreFilter, nextOffset: number) => {
      try {
        const page = await loadStore(nextFilter, nextOffset, PAGE_SIZE);
        setRows(page.rows);
        setTotal(page.total);
        setNsfwHidden(page.nsfwHidden);
        setFailure(null);
      } catch (error) {
        setFailure(errorMessage(error));
      }
    },
    [],
  );

  useEffect(() => {
    void reload(filter, offset);
  }, [filter, offset, reload, status?.revision]);

  const handleRefresh = async () => {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      const directory = await loadDirectory(0, 100);
      // The backend drops these too, but filtering here keeps them from
      // consuming slots in a batch that is capped at eight.
      const targets = directory.entries
        .filter((entry) => !entry.ignored && !entry.retired)
        .map((entry) => entry.canister);
      if (targets.length === 0) {
        setMessage(
          directory.total === 0
            ? "Add a designer in the Directory first."
            : "Every designer in your directory is ignored or retired.",
        );
        return;
      }
      let fetched = 0;
      let failed = 0;
      let retired = 0;
      // The manifest caps one batch at eight peers, so walk the directory.
      for (let index = 0; index < targets.length; index += BATCH) {
        const slice = targets.slice(index, index + BATCH);
        const result = await fetchCatalogs(slice);
        fetched += result.fetched.length;
        failed += result.failed.length;
        retired += result.retired.length;
      }
      setMessage(
        `Refreshed ${fetched} designer${fetched === 1 ? "" : "s"}` +
          (failed > 0 ? `, ${failed} did not answer` : "") +
          // Said apart from "did not answer" because it is a different claim:
          // those have now gone quiet often enough to look uninstalled, and
          // nothing will call them again until the owner says otherwise.
          (retired > 0
            ? `, ${retired} marked retired after repeated silence.`
            : "."),
      );
      await reload(filter, offset);
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openOffer = async (row: StoreRow) => {
    setOfferFor(row);
    setMessage(null);
    setFailure(null);
    try {
      const [designs, collection] = await Promise.all([
        loadDesigns(),
        loadCollection(0, 100),
      ]);
      setOwnDesigns(designs.filter((design) => design.state === "published"));
      setHeldChips(collection.chips.filter((chip) => chip.state === "held"));
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  // The peer runs this same check on the art we would send it, so an offer that
  // fails here would come back declined. Saying so now saves a paid call, and
  // says which chip is wrong rather than only that something was.
  const offerFailure = useCallback(
    (
      row: StoreRow,
      candidate: { art: { palette: string[]; pixels: string }; nsfw: boolean },
    ): FailureCode | null =>
      check(
        row.requirements,
        measure(decodePixels(candidate.art.pixels), candidate.art.palette),
        candidate.nsfw,
      ),
    [],
  );

  const ownOffers = useMemo(
    () =>
      offerFor === null
        ? []
        : ownDesigns.map((design) => ({
            design,
            failure: offerFailure(offerFor, design),
          })),
    [offerFailure, offerFor, ownDesigns],
  );

  const heldOffers = useMemo(
    () =>
      offerFor === null
        ? []
        : heldChips.map((chip) => ({ chip, failure: offerFailure(offerFor, chip) })),
    [heldChips, offerFailure, offerFor],
  );

  const propose = async (
    row: StoreRow,
    offer: { kind: "own"; designId: number } | { kind: "held"; chipKey: string },
  ) => {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      const result = await proposeTrade({
        peer: row.designer,
        wantDesignId: row.designId,
        offer,
      });
      setMessage(describeOutcome(result.outcome));
      setOfferFor(null);
      await reload(filter, offset);
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="nt-panel chipswap-store">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Store</h2>
        <span className="nt-section-count">
          {total} chip{total === 1 ? "" : "s"} · {filterLabel(filter)}
          {nsfwHidden > 0
            ? ` · ${nsfwHidden} NSFW hidden`
            : ""}
        </span>
      </header>

      <div className="chipswap-filters">
        {(
          [
            ["ownership", OWNERSHIP_OPTIONS],
            ["designerOwnership", DESIGNER_OPTIONS],
            ["policy", POLICY_OPTIONS],
            ["nsfw", NSFW_OPTIONS],
          ] as const
        ).map(([key, options]) => (
          <div className="nt-segmented" key={key}>
            {options.map((option) => (
              <button
                aria-pressed={filter[key] === option.value}
                className={cx("nt-button nt-button--sm", {
                  "nt-button--secondary": filter[key] !== option.value,
                })}
                key={option.value}
                onClick={() => {
                  setOffset(0);
                  setFilter((current) => ({ ...current, [key]: option.value }));
                }}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        ))}
        <button
          className="nt-button nt-button--sm"
          data-tid="chipswap-refresh-store"
          disabled={busy}
          onClick={handleRefresh}
          type="button"
        >
          Refresh catalogs
        </button>
      </div>

      {failure ? (
        <p className="nt-callout nt-callout--danger" role="alert">
          {failure}
        </p>
      ) : null}
      {message ? <p className="nt-callout">{message}</p> : null}

      {rows.length === 0 ? (
        <p className="nt-muted">
          Nothing here yet. Add designers in the Directory, then refresh
          catalogs to see what they have published.
        </p>
      ) : (
        <ul className="chipswap-grid">
          {rows.map((row) => (
            <li className="nt-card chipswap-chip-card" key={`${row.designer}:${row.designId}`}>
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
                <span className="nt-meta">
                  seen {formatTimestamp(row.fetchedAtNs)}
                </span>
                <button
                  className="nt-button nt-button--sm"
                  disabled={busy}
                  onClick={() => void openOffer(row)}
                  type="button"
                >
                  Trade for this
                </button>
              </div>
            </li>
          ))}
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

      {offerFor ? (
        <div className="nt-dialog chipswap-offer" role="dialog">
          <h3 className="nt-section-title">
            Offer a chip for “{offerFor.title}”
          </h3>
          <p className="nt-help">
            {describeRequirements(offerFor.requirements).length === 0
              ? "This designer asks for nothing in particular, so the swap completes immediately."
              : `This designer asks for ${describeRequirements(offerFor.requirements).join(", ")}.`}
            {offerFor.requirements.approval
              ? " Your chip waits with them until they decide."
              : ""}
          </p>

          <h4 className="nt-label">Your own designs</h4>
          {ownOffers.length === 0 ? (
            <p className="nt-muted">Publish a design to offer copies of it.</p>
          ) : (
            <ul className="chipswap-offer-list">
              {ownOffers.map(({ design, failure }) => (
                <li key={design.designId}>
                  <button
                    className="nt-button nt-button--sm"
                    disabled={busy || failure !== null}
                    onClick={() =>
                      void propose(offerFor, {
                        kind: "own",
                        designId: design.designId,
                      })
                    }
                    type="button"
                  >
                    {design.title}
                  </button>
                  <span className="nt-meta">
                    {failure === null
                      ? "mints a new copy — you keep yours"
                      : `refused: it ${failureMessage(failure)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h4 className="nt-label">Chips you hold</h4>
          {heldOffers.length === 0 ? (
            <p className="nt-muted">No tradeable chips in your collection.</p>
          ) : (
            <ul className="chipswap-offer-list">
              {heldOffers.map(({ chip, failure }) => (
                <li key={chip.key}>
                  <button
                    className="nt-button nt-button--secondary nt-button--sm"
                    disabled={busy || failure !== null}
                    onClick={() =>
                      void propose(offerFor, { kind: "held", chipKey: chip.key })
                    }
                    type="button"
                  >
                    {chip.title} #{chip.serial}
                  </button>
                  <span className="nt-meta">
                    {failure === null
                      ? "you will no longer own this chip"
                      : `refused: it ${failureMessage(failure)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <button
            className="nt-button nt-button--ghost nt-button--sm"
            onClick={() => setOfferFor(null)}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </section>
  );
};

function describeOutcome(outcome: string): string {
  switch (outcome) {
    case "completed":
      return "Traded. The new chip is in your collection.";
    case "pending":
      return "Offer sent. The designer will decide, and your chip waits with them.";
    case "declined":
      return "The designer declined the offer. Your chip is available again.";
    case "failed":
      return "The designer refused the request. Your chip is available again.";
    case "uncertain":
      return "The other Neutron did not answer. Check the Collection to resolve it.";
    default:
      return `Outcome: ${outcome}`;
  }
}
