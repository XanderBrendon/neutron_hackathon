import { useCallback, useEffect, useState } from "react";
import { cx } from "neutron-design-system";
import {
  acceptTrade,
  declineTrade,
  errorMessage,
  forgetTrade,
  formatTimestamp,
  loadTrades,
  resolveTrade,
  shortPrincipal,
  type IncomingTrade,
  type OutgoingTrade,
} from "../api.ts";
import { ChipCanvas } from "../chip_canvas.tsx";
import { decodePixels } from "../chip.ts";

type Props = {
  onChanged: () => void | Promise<void>;
};

const OUTGOING_LABEL: Record<OutgoingTrade["state"], string> = {
  sending: "Sending",
  pending_designer: "Waiting for the designer",
  completed: "Completed",
  declined: "Declined",
  failed: "Failed",
  uncertain: "Outcome unknown",
};

export const Trades = ({ onChanged }: Props) => {
  const [incoming, setIncoming] = useState<IncomingTrade[]>([]);
  const [outgoing, setOutgoing] = useState<OutgoingTrade[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const trades = await loadTrades();
      setIncoming(trades.incoming);
      setOutgoing(trades.outgoing);
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, []);

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
                          "nt-tag--success": trade.state === "completed",
                          "nt-tag--warning":
                            trade.state === "pending_designer" ||
                            trade.state === "sending",
                          "nt-tag--danger":
                            trade.state === "uncertain" || trade.state === "failed",
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
                      {trade.state === "uncertain" || trade.state === "pending_designer" ? (
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
                      ) : (
                        <button
                          className="nt-button nt-button--ghost nt-button--sm"
                          disabled={busy === trade.requestId}
                          onClick={() =>
                            void run(trade.requestId, async () => {
                              await forgetTrade(trade.requestId);
                              return "Cleared.";
                            })
                          }
                          type="button"
                        >
                          Clear
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};
