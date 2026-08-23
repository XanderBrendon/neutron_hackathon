import { useCallback, useEffect, useState } from "react";
import { cx } from "neutron-design-system";
import {
  abandonTrade,
  acceptTrade,
  clearTradeHistory,
  declineTrade,
  errorMessage,
  forgetHistoryEntry,
  formatTimestamp,
  loadTradeHistory,
  loadTrades,
  resolveTrade,
  shortPrincipal,
  type IncomingTrade,
  type OutgoingTrade,
  type TradeHistoryEntry,
} from "../api.ts";
import { ChipCanvas } from "../chip_canvas.tsx";
import { decodePixels } from "../chip.ts";

type Props = {
  onChanged: () => void | Promise<void>;
};

const OUTGOING_LABEL: Record<OutgoingTrade["state"], string> = {
  sending: "Sending",
  pending_designer: "Waiting for the designer",
  uncertain: "Outcome unknown",
};

const OUTCOME_LABEL: Record<TradeHistoryEntry["outcome"], string> = {
  traded: "Traded",
  declined_by_peer: "They declined",
  declined_by_owner: "You declined",
  failed: "Failed",
  unresolved: "Never confirmed",
};

const HISTORY_PAGE = 25;

type HistoryPanelProps = {
  entries: TradeHistoryEntry[];
  total: number;
  busy: string | null;
  onForget: (entryId: number) => void;
  onClear: () => void;
  onAskAgain: (requestId: string) => void;
  onShowMore: () => void;
};

// A chip that never moved has nothing to name, and saying so beats an empty
// cell that reads like a rendering bug.
const chipCell = (chip: TradeHistoryEntry["ours"]) =>
  chip ? <span>{chip.title}</span> : <span className="nt-muted">—</span>;

export const HistoryPanel = ({
  entries,
  total,
  busy,
  onForget,
  onClear,
  onAskAgain,
  onShowMore,
}: HistoryPanelProps) => (
  <div className="nt-panel">
    <header className="nt-section-header">
      <h2 className="nt-section-heading">History</h2>
      <span className="nt-section-count">{total}</span>
      {entries.length > 0 ? (
        <button
          className="nt-button nt-button--ghost nt-button--sm"
          onClick={onClear}
          type="button"
        >
          Forget settled
        </button>
      ) : null}
    </header>

    {entries.length === 0 ? (
      <p className="nt-muted">
        No finished trades yet. Every trade you complete, and every offer you
        turn down, is recorded here.
      </p>
    ) : (
      <>
        <div className="nt-table-wrap">
          <table className="nt-table">
            <thead>
              <tr>
                <th>Settled</th>
                <th>With</th>
                <th>Yours</th>
                <th>Theirs</th>
                <th>Outcome</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((row) => (
                <tr key={row.entryId}>
                  <td>{formatTimestamp(row.settledAtNs)}</td>
                  <td title={row.peer}>
                    {row.contactName ?? shortPrincipal(row.peer)}
                  </td>
                  <td>{chipCell(row.ours)}</td>
                  <td>{chipCell(row.theirs)}</td>
                  <td>
                    <span
                      className={cx("nt-tag", {
                        "nt-tag--success": row.outcome === "traded",
                        "nt-tag--danger": row.outcome === "failed",
                        "nt-tag--warning": row.outcome === "unresolved",
                      })}
                    >
                      {OUTCOME_LABEL[row.outcome]}
                    </span>
                    {row.detail ? (
                      <span className="nt-meta"> {row.detail}</span>
                    ) : null}
                  </td>
                  <td>
                    <div className="nt-cluster">
                      {row.outcome === "unresolved" ? (
                        <button
                          className="nt-button nt-button--sm"
                          disabled={busy === row.requestId}
                          onClick={() => onAskAgain(row.requestId)}
                          type="button"
                        >
                          Ask again
                        </button>
                      ) : null}
                      <button
                        className="nt-button nt-button--ghost nt-button--sm"
                        disabled={busy === String(row.entryId)}
                        onClick={() => onForget(row.entryId)}
                        type="button"
                      >
                        Forget
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {entries.length < total ? (
          <button
            className="nt-button nt-button--ghost nt-button--sm"
            onClick={onShowMore}
            type="button"
          >
            Show more
          </button>
        ) : null}
      </>
    )}
  </div>
);

export const Trades = ({ onChanged }: Props) => {
  const [incoming, setIncoming] = useState<IncomingTrade[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingTrade[]>([]);
  const [history, setHistory] = useState<TradeHistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [trades, ledger] = await Promise.all([
        loadTrades(),
        loadTradeHistory(0, historyLimit),
      ]);
      setIncoming(trades.incoming);
      setOutgoing(trades.outgoing);
      setHistory(ledger.entries);
      setHistoryTotal(ledger.total);
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, [historyLimit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (
    requestId: string,
    action: () => Promise<string>,
  ): Promise<void> => {
    setBusy(requestId);
    setFailure(null);
    setMessage(null);
    try {
      setMessage(await action());
      await reload();
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="chipswap-trades">
      <div className="nt-panel">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Offers waiting on you</h2>
          <span className="nt-section-count">{incoming.length}</span>
        </header>

        {failure ? (
          <p className="nt-callout nt-callout--danger" role="alert">
            {failure}
          </p>
        ) : null}
        {message ? <p className="nt-callout">{message}</p> : null}

        {incoming.length === 0 ? (
          <p className="nt-muted">
            Nothing waiting. Designs set to “approve each trade” collect their
            offers here.
          </p>
        ) : (
          <ul className="chipswap-trade-list">
            {incoming.map((trade) => (
              <li className="nt-card chipswap-trade-card" key={trade.requestId}>
                <ChipCanvas
                  label={`Offered chip ${trade.offered.title}`}
                  palette={trade.offered.art.palette}
                  pixels={decodePixels(trade.offered.art.pixels)}
                  scale={4}
                />
                <div className="chipswap-trade-meta">
                  <strong>{trade.offered.title}</strong>
                  {trade.offered.nsfw ? (
                    <span className="nt-tag nt-tag--warning">NSFW</span>
                  ) : null}
                  <span className="nt-meta" title={trade.peer}>
                    offered by {trade.contactName ?? shortPrincipal(trade.peer)}
                  </span>
                  <span className="nt-meta">
                    wants “{trade.wantTitle}” (design {trade.wantDesignId})
                  </span>
                  <span className="nt-meta">
                    {formatTimestamp(trade.receivedAtNs)}
                  </span>
                  <span
                    className={cx("nt-tag", {
                      "nt-tag--warning": trade.state === "pending",
                    })}
                  >
                    {trade.state}
                  </span>
                  <div className="nt-cluster">
                    <button
                      className="nt-button nt-button--sm"
                      disabled={busy === trade.requestId}
                      onClick={() =>
                        void run(trade.requestId, async () => {
                          const result = await acceptTrade(trade.requestId);
                          return result.outcome === "delivered"
                            ? "Accepted. Your chip is on its way and theirs is in your collection."
                            : "Accepted, but the delivery did not confirm. Try again from here.";
                        })
                      }
                      type="button"
                    >
                      {trade.state === "pending" ? "Accept" : "Retry delivery"}
                    </button>
                    {trade.state === "pending" ? (
                      <button
                        className="nt-button nt-button--danger nt-button--sm"
                        disabled={busy === trade.requestId}
                        onClick={() =>
                          void run(trade.requestId, async () => {
                            const result = await declineTrade(trade.requestId);
                            return result.outcome === "delivered"
                              ? "Declined. Their chip went back to them."
                              : "Declined, but the return did not confirm. Try again from here.";
                          })
                        }
                        type="button"
                      >
                        Decline
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="nt-panel">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Your offers</h2>
          <span className="nt-section-count">{outgoing.length}</span>
        </header>

        {outgoing.length === 0 ? (
          <p className="nt-muted">No trades proposed yet.</p>
        ) : (
          <div className="nt-table-wrap">
            <table className="nt-table">
              <thead>
                <tr>
                  <th>Offered</th>
                  <th>To</th>
                  <th>Wanted</th>
                  <th>State</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {outgoing.map((trade) => (
                  <tr key={trade.requestId}>
                    <td>{trade.offeredTitle}</td>
                    <td title={trade.peer}>
                      {trade.contactName ?? shortPrincipal(trade.peer)}
                    </td>
                    <td>design {trade.wantDesignId}</td>
                    <td>
                      <span
                        className={cx("nt-tag", {
                          "nt-tag--warning":
                            trade.state === "pending_designer" ||
                            trade.state === "sending",
                          "nt-tag--danger": trade.state === "uncertain",
                        })}
                      >
                        {OUTGOING_LABEL[trade.state]}
                      </span>
                      {trade.detail ? (
                        <span className="nt-meta"> {trade.detail}</span>
                      ) : null}
                    </td>
                    <td>{formatTimestamp(trade.updatedAtNs)}</td>
                    <td>
                      <div className="nt-cluster">
                        {trade.state === "sending" ? null : (
                          <button
                            className="nt-button nt-button--sm"
                            disabled={busy === trade.requestId}
                            onClick={() =>
                              void run(trade.requestId, async () => {
                                const result = await resolveTrade(trade.requestId);
                                return `Designer answered: ${result.outcome}.`;
                              })
                            }
                            type="button"
                          >
                            Ask the designer
                          </button>
                        )}
                        {trade.state === "uncertain" ? (
                          <button
                            className="nt-button nt-button--ghost nt-button--sm"
                            disabled={busy === trade.requestId}
                            onClick={() =>
                              void run(trade.requestId, async () => {
                                await abandonTrade(trade.requestId);
                                return "Set aside. Your chip stays committed until the designer answers, and you can ask again from History.";
                              })
                            }
                            type="button"
                          >
                            Give up
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <HistoryPanel
        busy={busy}
        entries={history}
        onAskAgain={(requestId) =>
          void run(requestId, async () => {
            const result = await resolveTrade(requestId);
            return `Designer answered: ${result.outcome}.`;
          })
        }
        onClear={() =>
          void run("history", async () => {
            await clearTradeHistory();
            return "Settled trades cleared. Anything still unconfirmed stayed.";
          })
        }
        onForget={(entryId) =>
          void run(String(entryId), async () => {
            await forgetHistoryEntry(entryId);
            return "Forgotten.";
          })
        }
        onShowMore={() => setHistoryLimit((current) => current + HISTORY_PAGE)}
        total={historyTotal}
      />
    </section>
  );
};
