import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import { errorMessage, loadStatus, type Status } from "./api.ts";
import { Collection } from "./views/collection.tsx";
import { DirectoryView } from "./views/directory.tsx";
import { Market } from "./views/market.tsx";
import { Studio } from "./views/studio.tsx";
import { Trades } from "./views/trades.tsx";
import "./style.scss";

const VIEWS = [
  { id: "studio", label: "Studio" },
  { id: "collection", label: "Collection" },
  { id: "market", label: "Market" },
  { id: "trades", label: "Trades" },
  { id: "directory", label: "Directory" },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

export const App = () => {
  const [view, setView] = useState<ViewId>("studio");
  const [status, setStatus] = useState<Status | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await loadStatus());
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = status?.incomingPending ?? 0;

  return (
    <main className={cx(nt.appFill, "chipswap")}>
      <div className="nt-page chipswap-shell">
        <header className="nt-page-header chipswap-header">
          <div className="chipswap-heading">
            <p className="nt-eyebrow">Chipswap</p>
            <h1 className="nt-title">Design, publish, and trade pixel chips</h1>
          </div>
          <dl aria-label="Chipswap summary" className="nt-kv chipswap-summary">
            <dt>Slots</dt>
            <dd data-tid="chipswap-slots">
              {status ? `${status.slotsUsed} / ${status.slotLimit}` : "—"}
            </dd>
            <dt>Chips</dt>
            <dd data-tid="chipswap-holdings">{status ? status.holdings : "—"}</dd>
            <dt>Designers</dt>
            <dd>{status ? status.directoryCount : "—"}</dd>
          </dl>
        </header>

        {failure ? (
          <p className="nt-callout nt-callout--danger" role="alert">
            {failure}
          </p>
        ) : null}

        <nav className="nt-tabs chipswap-tabs">
          <div className="nt-tab-list" role="tablist">
            {VIEWS.map((entry) => (
              <button
                aria-selected={view === entry.id}
                className={cx("nt-tab", { "nt-tab--active": view === entry.id })}
                data-tid={`chipswap-tab-${entry.id}`}
                key={entry.id}
                onClick={() => setView(entry.id)}
                role="tab"
                type="button"
              >
                {entry.label}
                {entry.id === "trades" && pending > 0 ? (
                  <span className="nt-tag nt-tag--warning chipswap-badge">{pending}</span>
                ) : null}
              </button>
            ))}
          </div>
        </nav>

        <div className="nt-page-main chipswap-main">
          {view === "studio" ? <Studio status={status} onChanged={refresh} /> : null}
          {view === "collection" ? (
            <Collection status={status} onChanged={refresh} />
          ) : null}
          {view === "market" ? <Market status={status} onChanged={refresh} /> : null}
          {view === "trades" ? <Trades onChanged={refresh} /> : null}
          {view === "directory" ? (
            <DirectoryView status={status} onChanged={refresh} />
          ) : null}
        </div>
      </div>
    </main>
  );
};

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}

createRoot(container).render(<App />);
