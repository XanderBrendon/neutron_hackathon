import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { cx, nt } from "neutron-design-system";
import { loadNeutronCanisterId } from "neutron-tools/app";
import "./style.scss";

export const App = () => {
  const [canisterId, setCanisterId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadNeutronCanisterId()
      .then((id) => {
        if (!cancelled) setCanisterId(id);
      })
      .catch(() => {
        if (!cancelled) setCanisterId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className={cx(nt.appFill, "chipswap")}>
      <div className="nt-page chipswap-shell">
        <header className="nt-page-header">
          <div>
            <p className="nt-eyebrow">Chipswap</p>
            <h1 className="nt-title">Design and trade pixel chips</h1>
          </div>
        </header>
        <section className="nt-panel chipswap-status">
          <p className="nt-text">Neutron canister: {canisterId ?? "loading"}</p>
        </section>
      </div>
    </main>
  );
};

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element not found");
}

createRoot(container).render(<App />);
