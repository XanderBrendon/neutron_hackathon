import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { cx } from "neutron-design-system";
import {
  errorMessage,
  loadCollection,
  loadDesigns,
  loadDirectory,
  formatMsTimestamp,
  proposeTrade,
  removeDirectoryEntry,
  setDirectoryIgnored,
  shortPrincipal,
  type Chip,
  type Design,
  type DirectoryEntry,
  type MarketFilter,
  type Status,
} from "../api.ts";
import {
  evictCatalogs,
  loadCachedCatalogs,
  refreshCatalogs,
} from "../catalog_client.ts";
import { failedDesigners } from "../catalog_failure.ts";
import {
  buildMarketPage,
  ownedKey,
  type MarketRow,
} from "../market_page.ts";
import { CATALOG_TTL_MS, staleDesigners } from "../resident/freshness.ts";
import type { CachedCatalog } from "../resident/store.ts";
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
const DIRECTORY_PAGE = 100;
// A whole directory is 512 entries, so this is the walk's ceiling rather than a
// sample of it: a designer missing from the picker would look like a designer
// with nothing to show.
const DIRECTORY_CEILING = 512;
// Long enough that typing a word does not cost a query per keystroke, short
// enough that the market does not feel like it is lagging behind the box.
const SEARCH_DEBOUNCE_MS = 250;

// A whole directory is 512 entries, so the walk reads all of them rather than
// a sample: a designer missing from the picker would look like a designer with
// nothing to show.
async function loadWholeDirectory(): Promise<DirectoryEntry[]> {
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
      return found;
    }
  }
}

type Props = {
  status: Status | null;
  onChanged: () => void | Promise<void>;
  /**
   * Owned by the shell, which outlives this view: leaving the Market unmounts
   * it, and a filter kept here would not be here to come back to. Still a
   * setter rather than a plain callback, so the amendments below can keep
   * building on the current filter rather than on the one they last rendered.
   */
  filter: MarketFilter;
  setFilter: Dispatch<SetStateAction<MarketFilter>>;
};

export const Market = ({ status, onChanged, filter, setFilter }: Props) => {
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The box is its own state so a query is not sent for every keystroke. The
  // filter is what the market was actually asked for, and a search carried back
  // in has to start out in both or the box would look empty while it applied.
  const [searchDraft, setSearchDraft] = useState(filter.search);
  const [designers, setDesigners] = useState<DirectoryEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offerFor, setOfferFor] = useState<MarketRow | null>(null);
  const [ownDesigns, setOwnDesigns] = useState<Design[]>([]);
  const [heldChips, setHeldChips] = useState<Chip[]>([]);

  // Everything the page is built from. The catalogs come from this machine's
  // cache; the rest comes from the canister, which is the only thing that knows
  // what we hold and who we follow.
  const [catalogs, setCatalogs] = useState<CachedCatalog[]>([]);
  const [ownedKeys, setOwnedKeys] = useState<Set<string>>(new Set());
  const [collection, setCollection] = useState<Chip[]>([]);
  const [allDesigns, setAllDesigns] = useState<Design[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cached, directory, held, designs] = await Promise.all([
        loadCachedCatalogs(),
        loadWholeDirectory(),
        loadCollection(0, DIRECTORY_PAGE),
        loadDesigns(),
      ]);
      setCatalogs(cached);
      setDesigners(directory);
      setCollection(held.chips);
      setAllDesigns(designs);
      setOwnedKeys(
        new Set(held.chips.map((chip) => ownedKey(chip.designer, chip.designId))),
      );
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, status?.revision]);

  // Rendered from what is already here, so a filter change is instant and does
  // not wait on the network. `total` is the filtered count, which is what the
  // page control below needs to stay honest.
  const page = useMemo(
    () =>
      buildMarketPage(
        {
          catalogs,
          directory: designers,
          ownedKeys,
          holdings: collection.filter((chip) => chip.origin === "held"),
          ownDesigns: allDesigns,
        },
        filter,
        offset,
        PAGE_SIZE,
      ),
    [catalogs, designers, ownedKeys, collection, allDesigns, filter, offset],
  );
  const rows = page.rows;
  const total = page.total;
  const nsfwHidden = page.nsfwHidden;

  // Read off the catalog cache rather than off the fetch that just ran, so it
  // is the same list whether the refresh was the automatic one on opening or
  // the button, and it survives a reload. A designer leaves it by answering, by
  // being ignored, or by being removed — the last two evict the cached catalog
  // that put them here.
  const failed = useMemo(
    () => failedDesigners(catalogs, designers),
    [catalogs, designers],
  );

  // What the owner decides about a designer who did not answer. Both endings
  // take the cached catalog with them: it is what puts the designer on the list
  // above, and one left behind would keep naming somebody already dealt with.
  const decide = async (canister: string, action: "ignore" | "remove") => {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      if (action === "ignore") {
        await setDirectoryIgnored(canister, true);
      } else {
        await removeDirectoryEntry(canister);
      }
      await evictCatalogs([canister]);
      await load();
      setMessage(
        action === "ignore"
          ? "Ignored. They will not be asked again until you say otherwise."
          : "Removed from your directory.",
      );
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  // Only a designer with something cached can put a row here, so those are the
  // only ones the picker offers. A designer whose catalog has not been fetched
  // yet would look like one with nothing to show.
  const pickable = useMemo(() => {
    const stocked = new Set(
      catalogs
        .filter((entry) => entry.designs.length > 0)
        .map((entry) => entry.designer),
    );
    return designers.filter(
      (entry) => !entry.ignored && stocked.has(entry.canister),
    );
  }, [catalogs, designers]);

  // Show what is cached first, then bring the stale peers up to date behind it.
  // Opening the market on a machine that fetched yesterday should show
  // yesterday's chips at once, not a spinner.
  useEffect(() => {
    if (!loaded) return;
    const eligible = designers
      .filter((entry) => !entry.ignored)
      .map((entry) => entry.canister);
    const stale = staleDesigners(eligible, catalogs, Date.now(), CATALOG_TTL_MS);
    if (stale.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        await refreshCatalogs(stale, false);
        if (!cancelled) setCatalogs(await loadCachedCatalogs());
      } catch (error) {
        // A refresh that could not run leaves the cached market on screen.
        if (!cancelled) setFailure(errorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on `loaded` and the directory rather than on
    // `catalogs`: refreshing writes catalogs, and watching them here would
    // start the next refresh from the result of the last one.
  }, [loaded, designers]);

  useEffect(() => {
    if (searchDraft === filter.search) return;
    const timer = setTimeout(() => {
      setOffset(0);
      setFilter((current) => ({ ...current, search: searchDraft }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter.search, searchDraft]);

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
      const targets = designers
        .filter((entry) => !entry.ignored)
        .map((entry) => entry.canister);
      if (targets.length === 0) {
        setMessage(
          designers.length === 0
            ? "Add a designer in the Directory first."
            : "Every designer in your directory is ignored.",
        );
        return;
      }
      // Asked for by hand, so every designer is re-read regardless of how
      // recently the last one landed. Batching is the background's business.
      const result = await refreshCatalogs(targets, true);
      setCatalogs(await loadCachedCatalogs());
      // The count is the summary; the callout above the filters names them and
      // offers the two things worth doing about it. Nothing here concludes
      // anything — silence is not evidence a designer is gone, and this app no
      // longer pretends otherwise on the owner's behalf.
      setMessage(
        `Refreshed ${result.fetched.length} designer` +
          `${result.fetched.length === 1 ? "" : "s"}` +
          (result.failed.length > 0
            ? `, ${result.failed.length} did not answer.`
            : "."),
      );
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openOffer = async (row: MarketRow) => {
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
      row: MarketRow,
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
    row: MarketRow,
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
      await load();
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

      {failed.length > 0 ? (
        <section
          aria-label="Designers who did not answer"
          className="nt-callout nt-callout--warning chipswap-unanswered"
          data-tid="chipswap-unanswered"
        >
          <strong>
            {failed.length} designer{failed.length === 1 ? "" : "s"} did not
            answer
          </strong>
          <p className="nt-help">
            Silence is not proof anybody is gone: a canister can be stopped, out
            of cycles, or on a release that cannot answer this yet. Chipswap
            draws no conclusion from it, so what happens next is yours.
          </p>
          <ul className="chipswap-unanswered-list">
            {failed.map((entry) => (
              <li key={entry.canister}>
                <span className="chipswap-unanswered-who">
                  <strong title={entry.canister}>
                    {entry.contactName ?? shortPrincipal(entry.canister)}
                  </strong>
                  <span className="nt-meta">{entry.reason}</span>
                  <span className="nt-meta">
                    {entry.lastFetchedAtMs === 0
                      ? "Nothing of theirs has ever been read on this machine."
                      : `Their chips are still here, from ${formatMsTimestamp(entry.lastFetchedAtMs)}.`}
                  </span>
                </span>
                <span className="nt-cluster">
                  <button
                    className="nt-button nt-button--sm"
                    disabled={busy}
                    onClick={() => void decide(entry.canister, "ignore")}
                    type="button"
                  >
                    Ignore
                  </button>
                  <button
                    className="nt-button nt-button--ghost nt-button--sm"
                    disabled={busy}
                    onClick={() => void decide(entry.canister, "remove")}
                    type="button"
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
              {pickable.map((entry) => (
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
                  seen {formatMsTimestamp(row.fetchedAtMs)}
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
