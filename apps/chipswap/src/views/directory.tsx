import { useCallback, useEffect, useRef, useState } from "react";
import { cx } from "neutron-design-system";
import { copyToClipboard } from "neutron-tools/app";
import {
  addDirectoryEntry,
  crawlStep,
  errorMessage,
  fetchCatalogs,
  formatTimestamp,
  loadDirectory,
  loadSuggestions,
  removeDirectoryEntry,
  setDirectoryIgnored,
  setDirectoryRetired,
  shortPrincipal,
  startCrawl,
  stopCrawl,
  type CrawlProgress,
  type DirectoryEntry,
  type Status,
  type Suggestion,
} from "../api.ts";

const PAGE_SIZE = 25;

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
  const [crawl, setCrawl] = useState<CrawlProgress | null>(null);
  // A ref rather than state: the loop below reads it between rounds, and a
  // state update would not be visible to a closure already running.
  const stopping = useRef(false);

  const reload = useCallback(async (nextOffset: number) => {
    try {
      const page = await loadDirectory(nextOffset, PAGE_SIZE);
      setEntries(page.entries);
      setTotal(page.total);
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, []);

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

  // The crawl runs in rounds so a long one shows its progress and can be
  // stopped. Each round is one call that asks up to eight designers for a page
  // of their directory; the loop ends when nothing is left to ask.
  const runCrawl = async (resume: boolean) => {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    stopping.current = false;
    try {
      // Resuming skips the reset, so a crawl interrupted by a closed tile
      // carries on from the designers it had already visited rather than
      // spending another round on all of them.
      let progress = resume ? await crawlStep() : await startCrawl();
      setCrawl(progress);
      while (!stopping.current && progress.remaining > 0) {
        progress = await crawlStep();
        setCrawl(progress);
        await reload(offset);
      }
      if (stopping.current) {
        await stopCrawl();
        setCrawl(null);
        setMessage(
          `Stopped after ${progress.queried} designer${progress.queried === 1 ? "" : "s"}, ` +
            `${progress.discovered} new.`,
        );
      } else {
        await stopCrawl();
        setCrawl(null);
        setMessage(
          progress.discovered === 0
            ? `Asked ${progress.queried} designer${progress.queried === 1 ? "" : "s"}. Nobody new.` +
              (progress.full ? " Your directory is full." : "")
            : `Found ${progress.discovered} new designer${progress.discovered === 1 ? "" : "s"} ` +
              `from ${progress.queried}.` +
              (progress.full ? " Your directory is now full." : ""),
        );
      }
      await reload(offset);
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
      setCrawl(null);
    } finally {
      stopping.current = false;
      setBusy(false);
    }
  };

  const crawling = crawl !== null;
  // State left by a crawl this tile is not currently driving: the owner closed
  // the tile, or reloaded, while one was part-way through.
  const interrupted =
    !crawling && status?.crawl.active && status.crawl.remaining > 0
      ? status.crawl
      : null;

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
            disabled={busy || total === 0}
            onClick={() => void runCrawl(false)}
            type="button"
          >
            Find more designers
          </button>
          {crawling ? (
            <button
              className="nt-button nt-button--secondary nt-button--sm"
              onClick={() => {
                stopping.current = true;
              }}
              type="button"
            >
              Stop
            </button>
          ) : null}
          {crawl ? (
            <span className="nt-meta" data-tid="chipswap-crawl-progress">
              asked {crawl.queried} · {crawl.remaining} to go ·{" "}
              {crawl.discovered} new
            </span>
          ) : null}
        </div>
        {interrupted ? (
          <p className="nt-callout">
            A crawl was left part-finished, with {interrupted.remaining} designer
            {interrupted.remaining === 1 ? "" : "s"} still to ask.{" "}
            <button
              className="nt-button nt-button--sm"
              disabled={busy}
              onClick={() => void runCrawl(true)}
              type="button"
            >
              Carry on
            </button>
          </p>
        ) : null}
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
                      <span className="nt-tag">{entry.source}</span>
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
                    <td>{entry.designCount}</td>
                    <td>
                      {entry.lastCatalogNs
                        ? formatTimestamp(entry.lastCatalogNs)
                        : "never"}
                    </td>
                    <td className="nt-cluster">
                      <button
                        className="nt-button nt-button--sm"
                        disabled={busy || entry.ignored || entry.retired}
                        onClick={() =>
                          void run(async () => {
                            const result = await fetchCatalogs([entry.canister]);
                            if (result.fetched.length > 0) {
                              return "Catalog refreshed.";
                            }
                            return result.retired.length > 0
                              ? "No answer again. Marked retired — they seem to have uninstalled Chipswap."
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
                            return entry.ignored
                              ? "Back in the store after the next refresh."
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
