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
  type DirectoryEntry,
  type MarketFilter,
  type Status,
  type StoreRow,
} from "../api.ts";
import { ChipCanvas } from "../chip_canvas.tsx";
import { decodePixels } from "../chip.ts";
import {
  MAX_SEARCH_CHARS,
  REQUIREMENT_FACETS,
  SORT_OPTIONS,
  defaultFilter,
  filterLabel,
  isDefaultFilter,
  toggleFacet,
  type MarketSort,
} from "../market_filter.ts";
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
const DIRECTORY_PAGE = 100;
// A whole directory is 512 entries, so this is the walk's ceiling rather than a
// sample of it: a designer missing from the picker would look like a designer
// with nothing to show.
const DIRECTORY_CEILING = 512;
// Long enough that typing a word does not cost a query per keystroke, short
// enough that the market does not feel like it is lagging behind the box.
const SEARCH_DEBOUNCE_MS = 250;

type Props = {
  status: Status | null;
  onChanged: () => void | Promise<void>;
};

export const Market = ({ status, onChanged }: Props) => {
  const [filter, setFilter] = useState<MarketFilter>(defaultFilter());
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The box is its own state so a query is not sent for every keystroke. The
  // filter is what the market was actually asked for.
  const [searchDraft, setSearchDraft] = useState("");
  const [designers, setDesigners] = useState<DirectoryEntry[]>([]);
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
    async (nextFilter: MarketFilter, nextOffset: number) => {
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

  useEffect(() => {
    if (searchDraft === filter.search) return;
    const timer = setTimeout(() => {
      setOffset(0);
      setFilter((current) => ({ ...current, search: searchDraft }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter.search, searchDraft]);

  // Only the designers who have something cached can put a row in the market,
  // so those are the only ones the picker offers.
  useEffect(() => {
    void (async () => {
      try {
        const found: DirectoryEntry[] = [];
        let cursor = 0;
        for (;;) {
          const page = await loadDirectory(cursor, DIRECTORY_PAGE);
          found.push(...page.entries);
          cursor += page.entries.length;
          if (
            page.entries.length === 0 ||
            cursor >= page.total ||
            cursor >= DIRECTORY_CEILING
          ) {
            break;
          }
        }
        setDesigners(
          found.filter(
            (entry) => !entry.ignored && !entry.retired && entry.designCount > 0,
          ),
        );
      } catch (error) {
        setFailure(errorMessage(error));
      }
    })();
  }, [status?.revision]);

  // Takes the change as a function of the current filter rather than a value,
  // so a facet toggled from a stale render cannot undo the one before it. Every
  // change also returns to the first page: the page a row sat on is a fact
  // about the old filter.
  const amend = (change: (current: MarketFilter) => Partial<MarketFilter>) => {
    setOffset(0);
    setFilter((current) => ({ ...current, ...change(current) }));
  };

  const clearFilters = () => {
    setOffset(0);
    setSearchDraft("");
    setFilter(defaultFilter());
  };

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
      // The manifest caps one batch at eight peers, so walk the directory.
      for (let index = 0; index < targets.length; index += BATCH) {
        const slice = targets.slice(index, index + BATCH);
        const result = await fetchCatalogs(slice);
        fetched += result.fetched.length;
        failed += result.failed.length;
      }
      // Silence here is reported and nothing more. A catalog read is a query,
      // and a designer who did not answer one has not thereby been judged
      // gone — that conclusion is drawn on the paid routes, and shows up as
      // the retired badge in the Directory rather than here.
      setMessage(
        `Refreshed ${fetched} designer${fetched === 1 ? "" : "s"}` +
          (failed > 0 ? `, ${failed} did not answer.` : "."),
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
    <section className="nt-panel chipswap-market">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Market</h2>
        <span className="nt-section-count">
          {total} chip{total === 1 ? "" : "s"} · {filterLabel(filter)}
          {nsfwHidden > 0 ? ` · ${nsfwHidden} NSFW hidden` : ""}
        </span>
      </header>

      <div className="chipswap-market-bar">
        {/* Outside the collapsed section on purpose: leaving tagged chips out
            is a standing choice, and asking for them should not require
            opening anything first. */}
        <label className="chipswap-check">
          <input
            checked={filter.showNsfw}
            className="nt-checkbox"
            data-tid="chipswap-show-nsfw"
            onChange={(event) => {
              const showNsfw = event.currentTarget.checked;
              amend(() => ({ showNsfw }));
            }}
            type="checkbox"
          />
          <span className="nt-label">Show NSFW</span>
        </label>
        <button
          className="nt-button nt-button--sm"
          data-tid="chipswap-refresh-catalogs"
          disabled={busy}
          onClick={handleRefresh}
          type="button"
        >
          Refresh catalogs
        </button>
      </div>

      <section className="nt-disclosure chipswap-filters">
        <button
          aria-controls="chipswap-market-filters"
          aria-expanded={filtersOpen}
          className="nt-disclosure-trigger"
          data-tid="chipswap-filters-toggle"
          onClick={() => setFiltersOpen((open) => !open)}
          type="button"
        >
          <span className="nt-disclosure-copy">
            <strong className="nt-disclosure-title">Filters</strong>
            <span className="nt-disclosure-description">{filterLabel(filter)}</span>
          </span>
          <span aria-hidden="true" className="nt-disclosure-chevron">
            ▾
          </span>
        </button>

        <div
          className="nt-disclosure-content chipswap-filter-grid"
          hidden={!filtersOpen}
          id="chipswap-market-filters"
        >
          <label className="nt-field">
            <span className="nt-label">Search</span>
            <input
              className="nt-input"
              maxLength={MAX_SEARCH_CHARS}
              onChange={(event) => setSearchDraft(event.currentTarget.value)}
              placeholder="Chip title"
              type="search"
              value={searchDraft}
            />
          </label>

          <label className="nt-field">
            <span className="nt-label">Designer</span>
            <select
              className="nt-select"
              onChange={(event) => {
                const designer = event.currentTarget.value || null;
                amend(() => ({ designer }));
              }}
              value={filter.designer ?? ""}
            >
              <option value="">All designers</option>
              {designers.map((entry) => (
                <option key={entry.canister} value={entry.canister}>
                  {entry.contactName ?? shortPrincipal(entry.canister)}
                </option>
              ))}
            </select>
          </label>

          <label className="nt-field">
            <span className="nt-label">Sort by</span>
            <select
              className="nt-select"
              onChange={(event) => {
                const sort = event.currentTarget.value as MarketSort;
                amend(() => ({ sort }));
              }}
              value={filter.sort}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="chipswap-facets">
            <legend className="nt-label">Trade requirements</legend>
            <p className="nt-help">
              Ticking more than one widens the market rather than narrowing it:
              you get the designs matching any of them.
            </p>
            {REQUIREMENT_FACETS.map((facet) => (
              <label className="chipswap-check" key={facet.value}>
                <input
                  checked={filter.requirements.includes(facet.value)}
                  className="nt-checkbox"
                  onChange={() =>
                    amend((current) => ({
                      requirements: toggleFacet(current.requirements, facet.value),
                    }))
                  }
                  type="checkbox"
                />
                <span className="nt-label">{facet.label}</span>
              </label>
            ))}
          </fieldset>

          <label className="chipswap-check">
            <input
              checked={filter.hideOwned}
              className="nt-checkbox"
              onChange={(event) => {
                const hideOwned = event.currentTarget.checked;
                amend(() => ({ hideOwned }));
              }}
              type="checkbox"
            />
            <span className="nt-label">Hide chips I already own</span>
          </label>

          <button
            className="nt-button nt-button--ghost nt-button--sm"
            disabled={isDefaultFilter(filter)}
            onClick={clearFilters}
            type="button"
          >
            Clear filters
          </button>
        </div>
      </section>

      {failure ? (
        <p className="nt-callout nt-callout--danger" role="alert">
          {failure}
        </p>
      ) : null}
      {message ? <p className="nt-callout">{message}</p> : null}

      {rows.length === 0 ? (
        <p className="nt-muted">
          {isDefaultFilter(filter)
            ? "Nothing here yet. Add designers in the Directory, then refresh catalogs to see what they have published."
            : "No chip matches these filters. Widen them, or clear them to see the whole market."}
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
