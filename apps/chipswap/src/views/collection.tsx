import { useCallback, useEffect, useState } from "react";
import {
  errorMessage,
  loadCollection,
  resolveTrade,
  type Chip,
  type Status,
} from "../api.ts";
import { decodePixels } from "../chip.ts";
import { ChipCard } from "../chip_card.tsx";
import { chipFileName, chipPngDataUrl } from "../chip_png.ts";
import { ChipSavePanel } from "../chip_save_panel.tsx";

const PAGE_SIZE = 24;

type Props = {
  status: Status | null;
  onChanged: () => void | Promise<void>;
};

export const Collection = ({ status, onChanged }: Props) => {
  const [chips, setChips] = useState<Chip[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<{
    title: string;
    fileName: string;
    scale: number;
    src: string;
  } | null>(null);

  const reload = useCallback(async (nextOffset: number) => {
    try {
      const page = await loadCollection(nextOffset, PAGE_SIZE);
      setChips(page.chips);
      setTotal(page.total);
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void reload(offset);
  }, [offset, reload, status?.revision]);

  // Drawn here rather than fetched: the collection already holds the art, so a
  // saved chip is a local render and never another call to the backend.
  const handleSave = (chip: Chip, scale: number) => {
    setFailure(null);
    try {
      const src = chipPngDataUrl(
        decodePixels(chip.art.pixels),
        chip.art.palette,
        scale,
      );
      // Our own designs are not holdings and carry no serial to name them by.
      const serial = chip.origin === "design" ? null : chip.serial;
      setSaving({
        title: chip.title,
        fileName: chipFileName(chip.title, serial, scale),
        scale,
        src,
      });
    } catch (error) {
      setFailure(errorMessage(error));
    }
  };

  const handleResolve = async (chip: Chip) => {
    if (!chip.requestId) return;
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      const outcome = await resolveTrade(chip.requestId);
      setMessage(describeOutcome(outcome.outcome));
      await reload(offset);
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="nt-panel chipswap-collection">
      <header className="nt-section-header">
        <h2 className="nt-section-heading">Collection</h2>
        <span className="nt-section-count">
          {total} chip{total === 1 ? "" : "s"}
          {status ? ` · ${status.holdings} of ${status.holdingsLimit} held` : ""}
        </span>
      </header>

      {failure ? (
        <p className="nt-callout nt-callout--danger" role="alert">
          {failure}
        </p>
      ) : null}
      {message ? <p className="nt-callout">{message}</p> : null}

      {chips.length === 0 ? (
        <p className="nt-muted">
          No chips yet. Open the Store to trade for one, or publish a design so
          other people can trade with you.
        </p>
      ) : (
        <ul className="chipswap-grid">
          {chips.map((chip) => (
            <ChipCard
              busy={busy}
              chip={chip}
              key={chip.key}
              onSave={handleSave}
              onResolve={(target) => void handleResolve(target)}
            />
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

      {saving ? (
        <ChipSavePanel
          fileName={saving.fileName}
          onClose={() => setSaving(null)}
          scale={saving.scale}
          src={saving.src}
          title={saving.title}
        />
      ) : null}
    </section>
  );
};

function describeOutcome(outcome: string): string {
  switch (outcome) {
    case "completed":
      return "The trade had gone through: the new chip is in your collection.";
    case "declined":
      return "The designer declined. Your chip is available again.";
    case "not_received":
      return "The designer never received the offer. Your chip is available again.";
    case "pending":
      return "The designer still has this offer waiting for a decision.";
    case "uncertain":
      return "The designer could not be reached. The chip stays committed.";
    default:
      return `Outcome: ${outcome}`;
  }
}
