import { useCallback, useEffect, useMemo, useState } from "react";
import { cx } from "neutron-design-system";
import {
  createDraft,
  deleteDraft,
  deleteBrush,
  errorMessage,
  loadBrushes,
  loadDesigns,
  publishDesign,
  saveBrush,
  saveDraft,
  setTradeMode,
  type Design,
  type Status,
  type TradeMode,
} from "../api.ts";
import {
  PRESET_BRUSHES,
  blankBrush,
  brushFromRecord,
  brushIsEmpty,
  toggleBrushCell,
  stamp,
  type Brush,
} from "../brushes.ts";
import { ChipCanvas } from "../chip_canvas.tsx";
import { decodePixels, encodePixels } from "../chip.ts";
import {
  addPaletteColor,
  applyGenerator,
  canRemovePaletteColor,
  createEditorState,
  endStroke,
  lockAllOfColor,
  markSaved,
  paint,
  paintLocks,
  redo,
  removePaletteColor,
  selectColor,
  undo,
  unlockAll,
  type EditorState,
} from "../editor_state.ts";
import { GENERATORS, renderGenerator, type GeneratorId } from "../patterns.ts";
import { blendColors, contrastColor } from "../palette.ts";

type Tool = "paint" | "lock" | "unlock";

type Props = {
  status: Status | null;
  onChanged: () => void | Promise<void>;
};

export const Studio = ({ status, onChanged }: Props) => {
  const [designs, setDesigns] = useState<Design[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [tool, setTool] = useState<Tool>("paint");
  const [brushId, setBrushId] = useState("dot");
  const [customBrushes, setCustomBrushes] = useState<Brush[]>([]);
  const [brushDraft, setBrushDraft] = useState<Brush | null>(null);
  const [brushName, setBrushName] = useState("");
  const [newColor, setNewColor] = useState("#7fd1c1");
  const [blendFrom, setBlendFrom] = useState(0);
  const [blendTo, setBlendTo] = useState(1);
  const [blendRatio, setBlendRatio] = useState(0.5);
  const [generatorId, setGeneratorId] = useState<GeneratorId>("rings");
  const [bands, setBands] = useState(4);
  const [rotation, setRotation] = useState(0);
  const [generatorColors, setGeneratorColors] = useState<number[]>([0, 1]);
  const [preview, setPreview] = useState<Uint8Array | null>(null);
  const [publishMode, setPublishMode] = useState<TradeMode>("auto");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = designs.find((design) => design.designId === selectedId) ?? null;
  const editable = selected?.state === "draft";

  const reload = useCallback(async () => {
    try {
      const rows = await loadDesigns();
      setDesigns(rows);
      setSelectedId((current) => {
        if (current !== null && rows.some((row) => row.designId === current)) {
          return current;
        }
        return rows[0]?.designId ?? null;
      });
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, []);

  const reloadBrushes = useCallback(async () => {
    try {
      const rows = await loadBrushes();
      setCustomBrushes(rows.map((row) => brushFromRecord(row)));
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadBrushes();
  }, [reload, reloadBrushes]);

  // Loading a design discards the working copy: the stored art is the truth.
  useEffect(() => {
    if (!selected) {
      setEditor(null);
      return;
    }
    setEditor(
      createEditorState({
        palette: selected.art.palette,
        pixels: decodePixels(selected.art.pixels),
      }),
    );
    setPreview(null);
    setConfirmPublish(false);
    setPublishMode(selected.tradeMode);
  }, [selected?.designId, selected?.revision, selected?.state]);

  const brushes = useMemo(
    () => [...PRESET_BRUSHES, ...customBrushes],
    [customBrushes],
  );
  const brush = brushes.find((candidate) => candidate.id === brushId) ?? PRESET_BRUSHES[0]!;

  // A drag is one edit: the first cell opens the stroke and the rest extend it,
  // so undo steps back over the whole line rather than one pixel at a time.
  const handlePaint = (x: number, y: number, phase: "start" | "move" | "end") => {
    if (!editor || !editable) return;
    if (phase === "end") {
      setEditor((current) => (current ? endStroke(current) : current));
      return;
    }
    const indices = stamp(brush, x, y);
    if (indices.length === 0) return;
    setPreview(null);
    const stroke = phase === "start" ? "begin" : "extend";
    setEditor((current) => {
      if (!current) return current;
      if (tool === "paint") {
        return paint(current, indices, current.activeColor, stroke);
      }
      return paintLocks(current, indices, tool === "lock", stroke);
    });
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      await action();
      await onChanged();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = () =>
    run(async () => {
      const designId = await createDraft(`Chip ${designs.length + 1}`);
      await reload();
      setSelectedId(designId);
      setMessage(`Draft ${designId} created.`);
    });

  const handleSave = () =>
    run(async () => {
      if (!editor || !selected) return;
      await saveDraft({
        designId: selected.designId,
        expectedRevision: selected.revision,
        title: selected.title,
        palette: editor.palette,
        pixels: encodePixels(editor.pixels),
      });
      setEditor((current) => (current ? markSaved(current) : current));
      await reload();
      setMessage("Draft saved.");
    });

  const handleRename = (title: string) =>
    run(async () => {
      if (!editor || !selected) return;
      await saveDraft({
        designId: selected.designId,
        expectedRevision: selected.revision,
        title,
        palette: editor.palette,
        pixels: encodePixels(editor.pixels),
      });
      await reload();
    });

  const handleDelete = () =>
    run(async () => {
      if (!selected) return;
      await deleteDraft(selected.designId);
      setSelectedId(null);
      await reload();
      setMessage("Draft deleted and its slot freed.");
    });

  const handlePublish = () =>
    run(async () => {
      if (!selected || !editor) return;
      // Publishing freezes exactly what is stored, so save first.
      if (editor.dirty) {
        await saveDraft({
          designId: selected.designId,
          expectedRevision: selected.revision,
          title: selected.title,
          palette: editor.palette,
          pixels: encodePixels(editor.pixels),
        });
      }
      const fresh = await loadDesigns();
      const current = fresh.find((design) => design.designId === selected.designId);
      if (!current) throw new Error("The design disappeared before publishing.");
      await publishDesign({
        designId: current.designId,
        expectedRevision: current.revision,
        tradeMode: publishMode,
      });
      setConfirmPublish(false);
      await reload();
      setMessage("Published. This chip is now public and permanent.");
    });

  const handleTradeMode = (mode: TradeMode) =>
    run(async () => {
      if (!selected) return;
      await setTradeMode(selected.designId, mode);
      await reload();
    });

  const handleSaveBrush = () =>
    run(async () => {
      if (!brushDraft || brushIsEmpty(brushDraft)) {
        throw new Error("Draw at least one cell before saving a brush.");
      }
      const name = brushName.trim() || "Custom";
      await saveBrush({
        id: null,
        name,
        width: brushDraft.width,
        height: brushDraft.height,
        anchorX: brushDraft.anchorX,
        anchorY: brushDraft.anchorY,
        cells: [...brushDraft.cells]
          .map((cell) => cell.toString(16).padStart(2, "0"))
          .join(""),
      });
      setBrushDraft(null);
      setBrushName("");
      await reloadBrushes();
      setMessage(`Brush "${name}" saved.`);
    });

  const handleDeleteBrush = (id: string) =>
    run(async () => {
      const numeric = Number(id.replace("custom-", ""));
      await deleteBrush(numeric);
      if (brushId === id) setBrushId("dot");
      await reloadBrushes();
    });

  const generator = GENERATORS.find((entry) => entry.id === generatorId)!;

  const handlePreview = () => {
    if (!editor) return;
    const indices = generatorColors.filter(
      (index) => index >= 0 && index < editor.palette.length,
    );
    if (indices.length === 0) {
      setFailure("Choose at least one palette colour for the generator.");
      return;
    }
    setFailure(null);
    setPreview(renderGenerator(generatorId, { paletteIndices: indices, bands, rotation }));
  };

  const handleApply = () => {
    if (!editor || !preview) return;
    setEditor(applyGenerator(editor, preview));
    setPreview(null);
    setMessage("Pattern applied. Locked pixels were left alone.");
  };

  const shownPixels = preview ?? editor?.pixels ?? new Uint8Array(0);

  return (
    <section className="chipswap-studio">
      <aside className="nt-panel chipswap-designs">
        <header className="nt-section-header">
          <h2 className="nt-section-heading">Designs</h2>
          <span className="nt-section-count">
            {status ? `${status.slotsUsed} / ${status.slotLimit} slots` : "—"}
          </span>
        </header>
        <ul className="chipswap-design-list">
          {designs.map((design) => (
            <li key={design.designId}>
              <button
                className={cx("chipswap-design-item", {
                  "chipswap-design-item--active": design.designId === selectedId,
                })}
                onClick={() => setSelectedId(design.designId)}
                type="button"
              >
                <ChipCanvas
                  label={`Design ${design.designId}`}
                  palette={design.art.palette}
                  pixels={decodePixels(design.art.pixels)}
                  scale={2}
                />
                <span className="chipswap-design-meta">
                  <strong>{design.title}</strong>
                  <span className={cx("nt-tag", {
                    "nt-tag--success": design.state === "published",
                  })}>
                    {design.state}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {designs.length === 0 ? (
            <li className="nt-muted">No designs yet.</li>
          ) : null}
        </ul>
        <footer className="nt-pane-footer">
          <button
            className="nt-button nt-button--sm"
            data-tid="chipswap-new-draft"
            disabled={busy || (status !== null && status.slotsUsed >= status.slotLimit)}
            onClick={handleCreate}
            type="button"
          >
            New draft
          </button>
          {editable ? (
            <button
              className="nt-button nt-button--danger nt-button--sm"
              disabled={busy}
              onClick={handleDelete}
              type="button"
            >
              Delete draft
            </button>
          ) : null}
        </footer>
      </aside>

      <div className="nt-panel chipswap-stage">
        {failure ? (
          <p className="nt-callout nt-callout--danger" role="alert">
            {failure}
          </p>
        ) : null}
        {message ? <p className="nt-callout">{message}</p> : null}

        {selected && editor ? (
          <>
            <div className="chipswap-stage-head">
              <label className="nt-field">
                <span className="nt-label">Title</span>
                <input
                  className="nt-input"
                  defaultValue={selected.title}
                  disabled={!editable || busy}
                  key={`${selected.designId}:${selected.revision}`}
                  onBlur={(event) => {
                    const value = event.currentTarget.value.trim();
                    if (value && value !== selected.title) void handleRename(value);
                  }}
                />
              </label>
              <span className="nt-meta">
                revision {selected.revision}
                {selected.state === "published"
                  ? ` · ${selected.mintedCount} minted`
                  : editor.dirty
                    ? " · unsaved changes"
                    : ""}
              </span>
            </div>

            <ChipCanvas
              className="chipswap-editor-canvas"
              label={`${selected.title} artwork`}
              locks={editor.locks}
              onPaint={editable ? handlePaint : undefined}
              palette={editor.palette}
              pixels={shownPixels}
              scale={12}
              showGrid
            />

            {preview ? (
              <div className="nt-cluster">
                <span className="nt-tag nt-tag--warning">Preview</span>
                <button className="nt-button nt-button--sm" onClick={handleApply} type="button">
                  Apply pattern
                </button>
                <button
                  className="nt-button nt-button--ghost nt-button--sm"
                  onClick={() => setPreview(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            ) : null}

            {editable ? (
              <div className="nt-toolbar chipswap-actions">
                <button
                  className="nt-button nt-button--sm"
                  data-tid="chipswap-save"
                  disabled={busy || !editor.dirty}
                  onClick={handleSave}
                  type="button"
                >
                  Save draft
                </button>
                <button
                  className="nt-button nt-button--ghost nt-button--sm"
                  disabled={!editor.canUndo}
                  onClick={() => setEditor(undo(editor))}
                  type="button"
                >
                  Undo
                </button>
                <button
                  className="nt-button nt-button--ghost nt-button--sm"
                  disabled={!editor.canRedo}
                  onClick={() => setEditor(redo(editor))}
                  type="button"
                >
                  Redo
                </button>
                <button
                  className="nt-button nt-button--warning nt-button--sm"
                  disabled={busy}
                  onClick={() => setConfirmPublish(true)}
                  type="button"
                >
                  Publish…
                </button>
              </div>
            ) : (
              <div className="nt-toolbar chipswap-actions">
                <span className="nt-meta">
                  Published art is permanent. Trade mode stays yours to change.
                </span>
                <div className="nt-segmented">
                  {(["auto", "manual"] as const).map((mode) => (
                    <button
                      aria-pressed={selected.tradeMode === mode}
                      className={cx("nt-button nt-button--sm", {
                        "nt-button--secondary": selected.tradeMode !== mode,
                      })}
                      disabled={busy}
                      key={mode}
                      onClick={() => void handleTradeMode(mode)}
                      type="button"
                    >
                      {mode === "auto" ? "Accept any trade" : "Approve each trade"}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {confirmPublish ? (
              <div className="nt-callout nt-callout--warning" role="alertdialog">
                <p className="nt-text">
                  Publishing makes this chip public and locks its artwork for
                  good. It keeps its slot permanently, and anyone who learns your
                  address can trade for copies.
                </p>
                <div className="nt-cluster">
                  <label className="nt-field">
                    <span className="nt-label">Trade mode</span>
                    <select
                      className="nt-select"
                      onChange={(event) =>
                        setPublishMode(event.currentTarget.value as TradeMode)
                      }
                      value={publishMode}
                    >
                      <option value="auto">Accept any chip automatically</option>
                      <option value="manual">Approve each trade myself</option>
                    </select>
                  </label>
                  <button
                    className="nt-button nt-button--warning nt-button--sm"
                    data-tid="chipswap-publish"
                    disabled={busy}
                    onClick={handlePublish}
                    type="button"
                  >
                    Publish permanently
                  </button>
                  <button
                    className="nt-button nt-button--ghost nt-button--sm"
                    onClick={() => setConfirmPublish(false)}
                    type="button"
                  >
                    Keep editing
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="nt-muted">
            Create a draft to start designing. A draft holds one of your ten
            slots until you delete or publish it.
          </p>
        )}
      </div>

      {selected && editor && editable ? (
        <aside className="nt-panel chipswap-tools">
          <section className="nt-section">
            <h3 className="nt-section-title">Palette</h3>
            <div className="chipswap-swatches">
              {editor.palette.map((colour, index) => (
                <button
                  aria-pressed={editor.activeColor === index}
                  className={cx("chipswap-swatch", {
                    "chipswap-swatch--active": editor.activeColor === index,
                  })}
                  key={`${colour}-${index}`}
                  onClick={() => setEditor(selectColor(editor, index))}
                  style={{ background: colour, color: contrastColor(colour) }}
                  title={colour}
                  type="button"
                >
                  {index}
                </button>
              ))}
            </div>
            <div className="nt-cluster">
              <input
                aria-label="New colour"
                className="chipswap-color-input"
                onChange={(event) => setNewColor(event.currentTarget.value)}
                type="color"
                value={newColor}
              />
              <button
                className="nt-button nt-button--sm"
                onClick={() => setEditor(addPaletteColor(editor, newColor))}
                type="button"
              >
                Add colour
              </button>
              <button
                className="nt-button nt-button--ghost nt-button--sm"
                disabled={!canRemovePaletteColor(editor, editor.activeColor)}
                onClick={() => setEditor(removePaletteColor(editor, editor.activeColor))}
                title={
                  canRemovePaletteColor(editor, editor.activeColor)
                    ? "Remove this colour"
                    : "This colour is still on the chip"
                }
                type="button"
              >
                Remove
              </button>
            </div>
          </section>

          <section className="nt-section">
            <h3 className="nt-section-title">Blend</h3>
            <div className="nt-cluster chipswap-blend">
              <select
                aria-label="Blend from"
                className="nt-select"
                onChange={(event) => setBlendFrom(Number(event.currentTarget.value))}
                value={blendFrom}
              >
                {editor.palette.map((colour, index) => (
                  <option key={index} value={index}>
                    {index}: {colour}
                  </option>
                ))}
              </select>
              <select
                aria-label="Blend to"
                className="nt-select"
                onChange={(event) => setBlendTo(Number(event.currentTarget.value))}
                value={blendTo}
              >
                {editor.palette.map((colour, index) => (
                  <option key={index} value={index}>
                    {index}: {colour}
                  </option>
                ))}
              </select>
              <input
                aria-label="Blend ratio"
                className="chipswap-range"
                max={1}
                min={0}
                onChange={(event) => setBlendRatio(Number(event.currentTarget.value))}
                step={0.05}
                type="range"
                value={blendRatio}
              />
              {(() => {
                const from = editor.palette[blendFrom] ?? "#000000";
                const to = editor.palette[blendTo] ?? "#ffffff";
                const blended = blendColors(from, to, blendRatio);
                return (
                  <button
                    className="nt-button nt-button--sm"
                    onClick={() => setEditor(addPaletteColor(editor, blended))}
                    style={{ background: blended, color: contrastColor(blended) }}
                    type="button"
                  >
                    Add {blended}
                  </button>
                );
              })()}
            </div>
          </section>

          <section className="nt-section">
            <h3 className="nt-section-title">Brush</h3>
            <div className="chipswap-brushes">
              {brushes.map((candidate) => (
                <span className="chipswap-brush-row" key={candidate.id}>
                  <button
                    aria-pressed={candidate.id === brushId}
                    className={cx("nt-button nt-button--sm", {
                      "nt-button--secondary": candidate.id !== brushId,
                    })}
                    onClick={() => setBrushId(candidate.id)}
                    type="button"
                  >
                    {candidate.name}
                  </button>
                  {candidate.id.startsWith("custom-") ? (
                    <button
                      aria-label={`Delete brush ${candidate.name}`}
                      className="nt-icon-button"
                      disabled={busy}
                      onClick={() => void handleDeleteBrush(candidate.id)}
                      type="button"
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
            {brushDraft ? (
              <div className="chipswap-brush-editor">
                <div
                  className="chipswap-brush-grid"
                  style={{ gridTemplateColumns: `repeat(${brushDraft.width}, 18px)` }}
                >
                  {[...brushDraft.cells].map((cell, offset) => {
                    const column = offset % brushDraft.width;
                    const row = Math.floor(offset / brushDraft.width);
                    const isAnchor =
                      column === brushDraft.anchorX && row === brushDraft.anchorY;
                    return (
                      <button
                        aria-label={`Cell ${column}, ${row}`}
                        className={cx("chipswap-brush-cell", {
                          "chipswap-brush-cell--on": cell === 1,
                          "chipswap-brush-cell--anchor": isAnchor,
                        })}
                        key={offset}
                        onClick={() =>
                          setBrushDraft(toggleBrushCell(brushDraft, column, row))
                        }
                        type="button"
                      />
                    );
                  })}
                </div>
                <div className="nt-cluster">
                  <input
                    aria-label="Brush name"
                    className="nt-input"
                    onChange={(event) => setBrushName(event.currentTarget.value)}
                    placeholder="Brush name"
                    value={brushName}
                  />
                  <button
                    className="nt-button nt-button--sm"
                    disabled={busy}
                    onClick={handleSaveBrush}
                    type="button"
                  >
                    Save brush
                  </button>
                  <button
                    className="nt-button nt-button--ghost nt-button--sm"
                    onClick={() => setBrushDraft(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                </div>
                <p className="nt-help">
                  The outlined cell is the anchor: it lands on the pixel you
                  click.
                </p>
              </div>
            ) : (
              <button
                className="nt-button nt-button--ghost nt-button--sm"
                onClick={() => setBrushDraft(blankBrush(5))}
                type="button"
              >
                New custom brush
              </button>
            )}
          </section>

          <section className="nt-section">
            <h3 className="nt-section-title">Locks</h3>
            <div className="nt-segmented">
              {(["paint", "lock", "unlock"] as const).map((mode) => (
                <button
                  aria-pressed={tool === mode}
                  className={cx("nt-button nt-button--sm", {
                    "nt-button--secondary": tool !== mode,
                  })}
                  key={mode}
                  onClick={() => setTool(mode)}
                  type="button"
                >
                  {mode === "paint" ? "Paint" : mode === "lock" ? "Lock" : "Unlock"}
                </button>
              ))}
            </div>
            <div className="nt-cluster">
              <button
                className="nt-button nt-button--sm"
                onClick={() => setEditor(lockAllOfColor(editor, editor.activeColor))}
                type="button"
              >
                Lock all of colour {editor.activeColor}
              </button>
              <button
                className="nt-button nt-button--ghost nt-button--sm"
                onClick={() => setEditor(unlockAll(editor))}
                type="button"
              >
                Unlock all
              </button>
            </div>
            <p className="nt-help">
              Locked pixels are hatched and no action writes to them, generators
              included.
            </p>
          </section>

          <section className="nt-section">
            <h3 className="nt-section-title">Patterns</h3>
            <label className="nt-field">
              <span className="nt-label">Generator</span>
              <select
                className="nt-select"
                onChange={(event) =>
                  setGeneratorId(event.currentTarget.value as GeneratorId)
                }
                value={generatorId}
              >
                {GENERATORS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="nt-help">{generator.description}</p>
            {generator.params.map((param) => (
              <label className="nt-field" key={param.key}>
                <span className="nt-label">
                  {param.label}: {param.key === "bands" ? bands : rotation}
                </span>
                <input
                  className="chipswap-range"
                  max={param.max}
                  min={param.min}
                  onChange={(event) => {
                    const value = Number(event.currentTarget.value);
                    if (param.key === "bands") setBands(value);
                    else setRotation(value);
                  }}
                  step={param.step}
                  type="range"
                  value={param.key === "bands" ? bands : rotation}
                />
              </label>
            ))}
            <fieldset className="nt-fieldset">
              <legend className="nt-label">Colours, in band order</legend>
              <div className="chipswap-swatches">
                {editor.palette.map((colour, index) => {
                  const position = generatorColors.indexOf(index);
                  return (
                    <button
                      aria-pressed={position >= 0}
                      className={cx("chipswap-swatch", {
                        "chipswap-swatch--active": position >= 0,
                      })}
                      key={index}
                      onClick={() =>
                        setGeneratorColors((current) =>
                          current.includes(index)
                            ? current.filter((entry) => entry !== index)
                            : [...current, index],
                        )
                      }
                      style={{ background: colour, color: contrastColor(colour) }}
                      type="button"
                    >
                      {position >= 0 ? position + 1 : ""}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <button
              className="nt-button nt-button--sm"
              data-tid="chipswap-preview-pattern"
              onClick={handlePreview}
              type="button"
            >
              Preview pattern
            </button>
          </section>
        </aside>
      ) : null}
    </section>
  );
};
