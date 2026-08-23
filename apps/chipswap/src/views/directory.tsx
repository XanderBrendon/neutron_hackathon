import { useCallback, useEffect, useState } from "react";
import { cx } from "neutron-design-system";
import { copyToClipboard, onAppStateChange } from "neutron-tools/app";
import {
  addDirectoryEntry,
  errorMessage,
  formatMsTimestamp,
  loadDirectory,
  loadSuggestions,
  removeDirectoryEntry,
  setDirectoryIgnored,
  setDirectoryRetired,
  shortPrincipal,
  type DirectoryEntry,
  type Status,
  type Suggestion,
} from "../api.ts";
import {
  crawlProgress,
  startCrawl,
  stopCrawl,
  type CrawlProgress,
} from "../crawl_client.ts";
import {
  evictCatalogs,
  loadCachedCatalogs,
  refreshCatalogs,
} from "../catalog_client.ts";
import type { CachedCatalog } from "../resident/store.ts";

const PAGE_SIZE = 25;

/** A designer this machine has never asked is not a designer with no designs. */
function designCountOf(cached: CachedCatalog | undefined): string {
  if (cached === undefined || cached.fetchedAtMs === 0) return "not fetched";
  return String(cached.designs.length);
}

function lastFetchOf(cached: CachedCatalog | undefined): string {
  if (cached === undefined) return "not fetched";
  // A peer still on the old caller policy lands here, and so does one that is
  // simply down. Naming it is what keeps their chips from vanishing from the
  // market for no stated reason.
  if (cached.fetchedAtMs === 0) {
    return cached.lastError === null ? "not fetched" : "didn't answer";
  }
  const when = formatMsTimestamp(cached.fetchedAtMs);
  return cached.lastError === null ? when : `${when} (didn't answer since)`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What a finished crawl actually did, in the owner's terms.
 *
 * `found` and `added` are different numbers and the difference matters: the
 * directory has a ceiling, and a crawl is not allowed to evict its way past
 * it. Reporting the finds alone would name designers the owner does not have.
 *
 * `outdated` is the other thing the old message could not say. After the
 * directory route opened to browsers, a peer on an older release refuses the
 * query outright — so an owner whose crawl comes back empty deserves to be
 * told it was a version gap rather than an empty network.
 */
function describeOutcome(progress: CrawlProgress): string {
  if (progress.error !== null && !progress.committed) {
    return `The crawl stopped: ${progress.error}. Nothing was saved.`;
  }

  const asked = `Asked ${plural(progress.queried, "designer")}.`;
  const gained =
    progress.added === 0
      ? "Nobody new."
      : `Added ${plural(progress.added, "designer")}.`;
  const parts = [asked, gained];

  if (progress.added < progress.found) {
    parts.push(
      `${plural(progress.found - progress.added, "other")} could not be added.`,
    );
  }
  if (progress.full) parts.push("Your directory is full.");
  if (progress.outdated > 0) {
    parts.push(
      `${plural(progress.outdated, "designer")} are on an older release and could not be asked.`,
    );
  }
  if (progress.error !== null) parts.push(`The crawl ended early: ${progress.error}.`);
  return parts.join(" ");
}

type Props = {
  status: Status | null;
  onChanged: () => void | Promise<void>;
};

export const DirectoryView = ({ status, onChanged }: Props) => {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [candidate, setCandidate] = useState("");
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [contactsAvailable, setContactsAvailable] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What the background says about the crawl. The tile drives it and draws it,
  // but does not run it: the walk outlives this component, so its state cannot
  // live in this component's memory.
  const [crawl, setCrawl] = useState<CrawlProgress | null>(null);

  // What this machine has fetched. The canister stopped counting designs when
  // it stopped storing them, so the two right-hand columns are answered from
  // the browser's own copy — and say "not fetched" where there is none, which
  // is a true statement where a zero would have been a false one.
  const [catalogs, setCatalogs] = useState<Map<string, CachedCatalog>>(new Map());

  const reloadCatalogs = useCallback(async () => {
    try {
      const cached = await loadCachedCatalogs();
      setCatalogs(new Map(cached.map((entry) => [entry.designer, entry])));
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, []);

  const reload = useCallback(
    async (nextOffset: number) => {
      try {
        const page = await loadDirectory(nextOffset, PAGE_SIZE);
        setEntries(page.entries);
        setTotal(page.total);
        setFailure(null);
      } catch (error) {
        setFailure(errorMessage(error));
      }
      await reloadCatalogs();
    },
    [reloadCatalogs],
  );

  const reloadSuggestions = useCallback(async (term: string) => {
    try {
      const page = await loadSuggestions(term, 0, 10);
      setSuggestions(page.rows);
      setContactsAvailable(page.available);
    } catch (error) {
      setContactsAvailable(false);
      setFailure(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void reload(offset);
  }, [offset, reload, status?.revision]);

  useEffect(() => {
    void reloadSuggestions(search);
  }, [reloadSuggestions, search]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      setMessage(await action());
      await reload(offset);
      await reloadSuggestions(search);
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  // The crawl belongs to the background, so the tile's job is to ask for one,
  // ask it to stop, and show what it says. Progress arrives on an app-state
  // nudge after each round rather than by polling on a timer.
  const readCrawl = useCallback(async () => {
    try {
      const progress = await crawlProgress();
      setCrawl(progress.active ? progress : null);
      return progress;
    } catch (error) {
      setFailure(errorMessage(error));
      return null;
    }
  }, []);

  // A crawl this tile did not start is still this owner's crawl. Reopening the
  // Directory during one picks it up rather than showing an idle button.
  useEffect(() => {
    void readCrawl();
    const stop = onAppStateChange("crawl", () => {
      void (async () => {
        const progress = await readCrawl();
        if (progress !== null && !progress.active) {
          setMessage(describeOutcome(progress));
          await reload(offset);
          await onChanged();
        }
      })();
    });
    return stop;
    // `offset` is read inside the listener rather than depended on: resubscribing
    // on every page turn would drop a nudge that arrived mid-swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readCrawl]);

  const beginCrawl = async () => {
    setFailure(null);
    setMessage(null);
    try {
      setCrawl(await startCrawl());
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  const endCrawl = async () => {
    try {
      // Stopping resolves only once the finds are committed, so the message
      // below describes a directory that has already changed.
      const outcome = await stopCrawl();
      setCrawl(null);
      setMessage(describeOutcome(outcome));
      await reload(offset);
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
      setCrawl(null);
    }
  };

  const crawling = crawl !== null && crawl.active;

  return (
    <section className="chipswap-directory">
      <div className="nt-panel">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Your Chipswap address</h2>
        </header>
        <div className="nt-cluster">
          <code className="nt-code" data-tid="chipswap-self-address">
            {status?.canister ?? "…"}
          </code>
          <button
            className="nt-button nt-button--sm"
            onClick={() => {
              if (status) void copyToClipboard(status.canister);
            }}
            type="button"
          >
            Copy
          </button>
        </div>
        <p className="nt-help">
          Share this with someone so they can add you and trade for your chips.
          Proposing a trade puts you in their directory, and from there other
          people find you.
        </p>

        <div className="nt-form-grid nt-form-grid--two">
          <label className="nt-field">
            <span className="nt-label">Add a designer</span>
            <input
              className="nt-input"
              data-tid="chipswap-add-designer"
              onChange={(event) => setCandidate(event.currentTarget.value)}
              placeholder="canister principal"
              value={candidate}
            />
          </label>
          <div className="nt-cluster chipswap-add-designer">
            <button
              className="nt-button nt-button--sm"
              disabled={busy || candidate.trim().length === 0}
              onClick={() =>
                void run(async () => {
                  const target = candidate.trim();
                  await addDirectoryEntry(target, "manual");
                  setCandidate("");
                  return `Added ${shortPrincipal(target)}.`;
                })
              }
              type="button"
            >
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="nt-panel">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">From your contacts</h2>
        </header>
        {contactsAvailable ? (
          <>
            <label className="nt-field">
              <span className="nt-label">Search contacts</span>
              <input
                className="nt-input"
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder="name"
                value={search}
              />
            </label>
            {suggestions.length === 0 ? (
              <p className="nt-muted">
                No contacts with a Neutron address match that search.
              </p>
            ) : (
              <ul className="chipswap-suggestions">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.principal}>
                    <span>{suggestion.contactName}</span>
                    <code className="nt-code" title={suggestion.principal}>
                      {shortPrincipal(suggestion.principal)}
                    </code>
                    {suggestion.inDirectory ? (
                      <span className="nt-tag nt-tag--success">in directory</span>
                    ) : (
                      <button
                        className="nt-button nt-button--sm"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await addDirectoryEntry(suggestion.principal, "contacts");
                            return `Added ${suggestion.contactName}.`;
                          })
                        }
                        type="button"
                      >
                        Add
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="nt-muted">The Contacts app did not answer.</p>
        )}
      </div>

      <div className="nt-panel">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Find more designers</h2>
        </header>
        <p className="nt-help">
          Asks every designer you know for their directory, then asks whoever
          that turns up, until there is nobody left to ask. Nothing is published
          about you: this only reads.
        </p>
        <div className="nt-cluster">
          <button
            className="nt-button nt-button--sm"
            disabled={busy || crawling || total === 0}
            onClick={() => void beginCrawl()}
            type="button"
          >
            Find more designers
          </button>
          {crawling ? (
            <button
              className="nt-button nt-button--secondary nt-button--sm"
              onClick={() => void endCrawl()}
              type="button"
            >
              Stop
            </button>
          ) : null}
          {crawl ? (
            <span className="nt-meta" data-tid="chipswap-crawl-progress">
              asked {crawl.queried} · {crawl.remaining} to go · {crawl.found}{" "}
              new
            </span>
          ) : null}
        </div>
        {total === 0 ? (
          <p className="nt-muted">
            Add one designer first. A crawl walks out from the ones you already
            know, so it needs somewhere to start.
          </p>
        ) : null}
        {crawl?.full ? (
          <p className="nt-callout nt-callout--danger" role="alert">
            Your directory is full. Remove or ignore some designers to make room
            for new ones.
          </p>
        ) : null}
      </div>

      <div className="nt-panel">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Known designers</h2>
          <span className="nt-section-count">{total}</span>
        </header>

        {failure ? (
          <p className="nt-callout nt-callout--danger" role="alert">
            {failure}
          </p>
        ) : null}
        {message ? <p className="nt-callout">{message}</p> : null}

        {entries.length === 0 ? (
          <p className="nt-muted">
            Nobody yet. Paste an address above, and then look for more designers
            through the ones you know.
          </p>
        ) : (
          <div className="nt-table-wrap">
            <table className="nt-table">
              <thead>
                <tr>
                  <th>Designer</th>
                  <th>Learned from</th>
                  <th>Designs</th>
                  <th>Last catalog</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.canister}>
                    <td>
                      <span title={entry.canister}>
                        {entry.contactName ?? shortPrincipal(entry.canister)}
                      </span>
                      {entry.ownsChip ? (
                        <span className="nt-tag nt-tag--success">own a chip</span>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className="nt-tag"
                        title={
                          entry.source === "seed"
                            ? "Chipswap was installed knowing this designer, so a new directory is not empty. Remove or ignore them like any other."
                            : undefined
                        }
                      >
                        {entry.source}
                      </span>
                      {entry.ignored ? (
                        <span className="nt-tag nt-tag--warning">ignored</span>
                      ) : null}
                      {entry.retired ? (
                        <span
                          className="nt-tag nt-tag--warning"
                          title="This canister stopped answering. Chips you already hold are yours to keep."
                        >
                          retired
                        </span>
                      ) : null}
                      {!entry.retired && entry.strikes > 0 ? (
                        <span
                          className="nt-tag"
                          title={`${entry.strikes} call${entry.strikes === 1 ? "" : "s"} in a row went unanswered.`}
                        >
                          unanswered ×{entry.strikes}
                        </span>
                      ) : null}
                    </td>
                    <td>{designCountOf(catalogs.get(entry.canister))}</td>
                    <td>{lastFetchOf(catalogs.get(entry.canister))}</td>
                    <td className="nt-cluster">
                      <button
                        className="nt-button nt-button--sm"
                        disabled={busy || entry.ignored || entry.retired}
                        onClick={() =>
                          void run(async () => {
                            const result = await refreshCatalogs(
                              [entry.canister],
                              true,
                            );
                            await reloadCatalogs();
                            return result.fetched.length > 0
                              ? "Catalog refreshed."
                              : "That designer did not answer.";
                          })
                        }
                        type="button"
                      >
                        Refresh
                      </button>
                      <button
                        className={cx("nt-button nt-button--sm", {
                          "nt-button--secondary": entry.retired,
                          "nt-button--ghost": !entry.retired,
                        })}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await setDirectoryRetired(
                              entry.canister,
                              !entry.retired,
                            );
                            if (!entry.retired) {
                              await evictCatalogs([entry.canister]);
                            }
                            return entry.retired
                              ? "Back in the rotation. Refresh to see whether they answer."
                              : "Marked retired. They will not be called again.";
                          })
                        }
                        type="button"
                      >
                        {entry.retired ? "Not retired" : "Retire"}
                      </button>
                      <button
                        className={cx("nt-button nt-button--sm", {
                          "nt-button--secondary": entry.ignored,
                          "nt-button--ghost": !entry.ignored,
                        })}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await setDirectoryIgnored(
                              entry.canister,
                              !entry.ignored,
                            );
                            if (!entry.ignored) {
                              await evictCatalogs([entry.canister]);
                            }
                            return entry.ignored
                              ? "Back in the market after the next refresh."
                              : "Ignored. Their chips will not be fetched or shown.";
                          })
                        }
                        type="button"
                      >
                        {entry.ignored ? "Stop ignoring" : "Ignore"}
                      </button>
                      <button
                        className="nt-button nt-button--ghost nt-button--sm"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await removeDirectoryEntry(entry.canister);
                            // Their catalog goes with them: a designer the
                            // owner stopped following should not leave their
                            // chips on this machine.
                            await evictCatalogs([entry.canister]);
                            return "Removed from your directory.";
                          })
                        }
                        type="button"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
      </div>
    </section>
  );
};
