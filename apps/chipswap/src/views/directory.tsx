import { useCallback, useEffect, useState } from "react";
import { cx } from "neutron-design-system";
import { copyToClipboard } from "neutron-tools/app";
import {
  addDirectoryEntry,
  announceTo,
  errorMessage,
  fetchCatalogs,
  formatTimestamp,
  loadDirectory,
  loadSuggestions,
  removeDirectoryEntry,
  setAutoAnnounce,
  shortPrincipal,
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
          <div className="nt-cluster">
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
            <button
              className="nt-button nt-button--secondary nt-button--sm"
              disabled={busy || candidate.trim().length === 0}
              onClick={() =>
                void run(async () => {
                  const target = candidate.trim();
                  await addDirectoryEntry(target, "manual");
                  await announceTo(target);
                  setCandidate("");
                  return `Added ${shortPrincipal(target)} and announced yourself.`;
                })
              }
              type="button"
            >
              Add and announce me
            </button>
          </div>
        </div>

        <label className="nt-field chipswap-auto-announce">
          <input
            checked={status?.autoAnnounce ?? false}
            disabled={busy}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              void run(async () => {
                await setAutoAnnounce(enabled);
                return enabled
                  ? "New designers will be announced to automatically."
                  : "Announcing stays a manual choice.";
              });
            }}
            type="checkbox"
          />
          <span className="nt-label">
            Announce me to designers I learn about while refreshing
          </span>
        </label>
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
            Nobody yet. Paste an address above, or trade once and your
            counterpart's directory arrives with the swap.
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
                      {entry.announced ? (
                        <span className="nt-tag nt-tag--success">announced</span>
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
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await fetchCatalogs([entry.canister]);
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
                          "nt-button--secondary": entry.announced,
                        })}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await announceTo(entry.canister);
                            return "They know about you now.";
                          })
                        }
                        type="button"
                      >
                        {entry.announced ? "Announce again" : "Announce me"}
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
