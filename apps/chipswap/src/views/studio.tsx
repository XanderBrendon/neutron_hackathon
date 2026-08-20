import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { BrushGlyph } from "../brush_glyph.tsx";
import { ChipCanvas } from "../chip_canvas.tsx";
import { decodePixels, encodePixels, pixelIndexAt } from "../chip.ts";
import {
  addPaletteColor,
  applyPattern,
  canRemovePaletteColor,
  createEditorState,
  endStroke,
  lockAllOfColor,
  markSaved,
  paint,
  paintLocks,
  patternFits,
  previewPattern,
  redo,
  removePaletteColor,
  selectColor,
  undo,
  unlockAll,
  type EditorState,
  type Pattern,
} from "../editor_state.ts";
import { floodRegion } from "../flood.ts";
import { buildStamp, coverPlacement } from "../image_stamp.ts";
import { clipboardImage, loadImage, type LoadedImage } from "../image_source.ts";
import { GENERATORS, renderGenerator, type GeneratorId } from "../patterns.ts";
import { MAX_PALETTE, blendColors, contrastColor } from "../palette.ts";

type Tool = "paint" | "fill" | "lock" | "unlock";

const TOOLS: Record<Tool, string> = {
  paint: "Paint",
  fill: "Fill",
  lock: "Lock",
  unlock: "Unlock",
};

/** Paints a control in the colour it stands for, with a legible label on top. */
const swatchStyle = (colour: string) => ({
  background: colour,
  color: contrastColor(colour),
});

type Props = {
  status: Status | null;
  onChanged: () => void | Promise<void>;
};

export const Studio = ({ status, onChanged }: Props) => {
  const [designs, setDesigns] = useState<Design[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [tool, setTool] = useState<Tool>("paint");
  // A drawing aid, not part of the chip: it stays out of the saved artwork.
  const [centerlines, setCenterlines] = useState(false);
  const [brushId, setBrushId] = useState("dot");
  const [customBrushes, setCustomBrushes] = useState<Brush[]>([]);
  const [brushDraft, setBrushDraft] = useState<Brush | null>(null);
  const [brushName, setBrushName] = useState("");
  // Deleting a brush is rare and unrecoverable, so it lives behind a mode
  // rather than behind a small cross beside every brush.
  const [editingBrushes, setEditingBrushes] = useState(false);
  const [markedBrushes, setMarkedBrushes] = useState<string[]>([]);
  const [newColor, setNewColor] = useState("#7fd1c1");
  const [picker, setPicker] = useState(false);
  const [blendFrom, setBlendFrom] = useState(0);
  const [blendTo, setBlendTo] = useState(1);
  const [blendRatio, setBlendRatio] = useState(0.5);
  const [generatorId, setGeneratorId] = useState<GeneratorId>("rings");
  const [bands, setBands] = useState(4);
  const [rotation, setRotation] = useState(0);
  const [generatorColors, setGeneratorColors] = useState<number[]>([0, 1]);
  const [preview, setPreview] = useState<Pattern | null>(null);
  // A picture waiting to be stamped. It is not part of the chip until it is,
  // so it lives here rather than in the editor's history.
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [stampColors, setStampColors] = useState(12);
  const [showImage, setShowImage] = useState(true);
  const [publishMode, setPublishMode] = useState<TradeMode>("auto");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);

  const selected = designs.find((design) => design.designId === selectedId) ?? null;
  const editable = selected?.state === "draft";
  // A full palette can take no more colours, so the flyout has nothing to offer.
  const full = (editor?.palette.length ?? 0) >= MAX_PALETTE;
  // The blend ends fall back to black and white so the flyout still renders
  // while a design is loading and the palette is not there yet.
  const blendSource = editor?.palette[blendFrom] ?? "#000000";
  const blendTarget = editor?.palette[blendTo] ?? "#ffffff";
  const blended = blendColors(blendSource, blendTarget, blendRatio);

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
    clearImage();
    setPicker(false);
    setConfirmPublish(false);
    setPublishMode(selected.tradeMode);
  }, [selected?.designId, selected?.revision, selected?.state]);

  // The colour flyout dismisses like any menu: Escape, or a press that lands
  // outside it. Pointerdown rather than click, so starting a stroke on the chip
  // puts it away before the paint lands.
  useEffect(() => {
    if (!picker) return;
    const dismiss = (event: PointerEvent) => {
      if (!paletteRef.current?.contains(event.target as Node)) setPicker(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicker(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [picker]);

  // A picture on the clipboard is the quickest way in, so a paste anywhere on
  // the page starts a stamp — except inside a text field, where a paste is text.
  useEffect(() => {
    if (!editable) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, [contenteditable]")
      ) {
        return;
      }
      const file = clipboardImage(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      void openImage(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [editable]);

  // A preview indexes into the palette it was made with, so changing the
  // palette puts it away rather than leaving it to be read against colours it
  // was never drawn for.
  useEffect(() => {
    setPreview(null);
  }, [editor?.palette]);

  const brushes = useMemo(
    () => [...PRESET_BRUSHES, ...customBrushes],
    [customBrushes],
  );
  const brush = brushes.find((candidate) => candidate.id === brushId) ?? PRESET_BRUSHES[0]!;

  // While the custom row is being edited a click marks a brush for deletion
  // instead of choosing it to paint with, and the mark outranks the accent so
  // it is never in doubt which brushes are about to go.
  const brushButton = (candidate: Brush) => {
    const editing = editingBrushes && candidate.id.startsWith("custom-");
    const marked = editing && markedBrushes.includes(candidate.id);
    return (
      <button
        aria-label={
          editing
            ? `Select brush ${candidate.name} for deletion`
            : `Brush ${candidate.name}`
        }
        aria-pressed={editing ? marked : candidate.id === brushId}
        className={cx("nt-button nt-button--sm chipswap-brush-button", {
          "nt-button--secondary": !marked && candidate.id !== brushId,
          "nt-button--danger": marked,
        })}
        key={candidate.id}
        onClick={() =>
          editing ? toggleMarkedBrush(candidate.id) : setBrushId(candidate.id)
        }
        title={candidate.name}
        type="button"
      >
        <BrushGlyph brush={candidate} />
      </button>
    );
  };

  // A drag is one edit: the first cell opens the stroke and the rest extend it,
  // so undo steps back over the whole line rather than one pixel at a time.
  const handlePaint = (x: number, y: number, phase: "start" | "move" | "end") => {
    if (!editor || !editable) return;
    if (phase === "end") {
      setEditor((current) => (current ? endStroke(current) : current));
      return;
    }
    if (tool === "fill") {
      // One click, one fill: a drag over the region it just painted must not
      // stack an undo entry for every pixel the pointer crosses.
      if (phase !== "start") return;
      const start = pixelIndexAt(x, y);
      if (start === null) return;
      setPreview(null);
      setEditor((current) =>
        current
          ? paint(
              current,
              floodRegion(current.pixels, current.locks, start),
              current.activeColor,
            )
          : current,
      );
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

  // The same stamp the click would use, split in two: everything the brush
  // covers is outlined so its position is visible, and the pixels that would
  // really change are tinted. A locked pixel stays inside the outline and takes
  // no tint, so the lock shows itself before the click rather than after it.
  const hoverPreview = useCallback(
    (x: number, y: number) => {
      if (!editor) return null;
      const ink = editor.palette[editor.activeColor] ?? "#f2f5f7";
      if (tool === "fill") {
        // The outline lands on the edge of the region itself, so a fill shows
        // how far it would run before it runs.
        const start = pixelIndexAt(x, y);
        const region =
          start === null ? [] : floodRegion(editor.pixels, editor.locks, start);
        if (region.length === 0) return null;
        return { cells: region, changes: region, colour: ink };
      }
      const cells = stamp(brush, x, y);
      if (cells.length === 0) return null;
      if (tool === "paint") {
        return {
          cells,
          changes: cells.filter((index) => editor.locks[index] !== 1),
          colour: ink,
        };
      }
      // Locking only changes an unlocked pixel, unlocking only a locked one.
      const changeable = tool === "lock" ? 0 : 1;
      return {
        cells,
        changes: cells.filter((index) => editor.locks[index] === changeable),
        colour: "#f2f5f7",
      };
    },
    [brush, editor, tool],
  );

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

  // Nothing on the network changed, so there is nothing to refresh: this is
  // the local half of run(), without the reload.
  const openImage = async (blob: Blob) => {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    try {
      const loaded = await loadImage(blob);
      setPreview(null);
      setImage(loaded);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setShowImage(true);
      setMessage("Drag the picture to place it, then stamp it onto the chip.");
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const handleChooseImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Cleared straight away, so choosing the same file twice still fires.
    event.currentTarget.value = "";
    if (file) void openImage(file);
  };

  // Reading the clipboard needs permission and some browsers have no such API,
  // so the key press is the path that always works and this is the shortcut.
  const handlePasteImage = async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((entry) => entry.startsWith("image/"));
        if (!type) continue;
        await openImage(await item.getType(type));
        return;
      }
      setFailure("There is no picture on the clipboard.");
    } catch {
      setFailure("This browser kept the clipboard to itself. Press Ctrl/Cmd+V instead.");
    }
  };

  // While a picture is being placed the chip is a drag surface rather than a
  // canvas: the pointer moves the picture instead of painting on it.
  const handleDragImage = (
    x: number,
    y: number,
    phase: "start" | "move" | "end",
  ) => {
    if (phase !== "move") {
      dragFrom.current = phase === "start" ? { x, y } : null;
      return;
    }
    const from = dragFrom.current;
    if (!from) return;
    dragFrom.current = { x, y };
    setOffset((current) => ({
      x: current.x + x - from.x,
      y: current.y + y - from.y,
    }));
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

  const toggleMarkedBrush = (id: string) =>
    setMarkedBrushes((marked) =>
      marked.includes(id)
        ? marked.filter((entry) => entry !== id)
        : [...marked, id],
    );

  const stopEditingBrushes = () => {
    setEditingBrushes(false);
    setMarkedBrushes([]);
  };

  const handleDeleteBrushes = () =>
    run(async () => {
      for (const id of markedBrushes) {
        await deleteBrush(Number(id.replace("custom-", "")));
        if (brushId === id) setBrushId("dot");
      }
      const count = markedBrushes.length;
      stopEditingBrushes();
      await reloadBrushes();
      setMessage(count === 1 ? "Brush deleted." : `${count} brushes deleted.`);
    });

  const clearImage = () => {
    setImage(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setShowImage(true);
  };

  const placement = useMemo(
    () => (image ? coverPlacement(image.raster, zoom, offset.x, offset.y) : null),
    [image, zoom, offset.x, offset.y],
  );
  // The palette decides how much of the picture can survive: colours it cannot
  // add are colours the picture has to do without.
  const room = MAX_PALETTE - (editor?.palette.length ?? MAX_PALETTE);
  const colourMax = Math.min(32, Math.max(0, room));
  const stampBudget = Math.min(stampColors, colourMax);
  // Resampled on every nudge of the placement, so the chip underneath the
  // picture is always the chip that stamping would produce.
  const stamped = useMemo(
    () =>
      image && editor && placement
        ? buildStamp(image.raster, placement, editor, stampBudget)
        : null,
    [editor, image, placement, stampBudget],
  );

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
    setPreview({
      pixels: renderGenerator(generatorId, { paletteIndices: indices, bands, rotation }),
      palette: editor.palette,
    });
  };

  const handleApply = () => {
    if (!editor || !preview) return;
    setEditor(applyPattern(editor, preview));
    setPreview(null);
    setMessage("Pattern applied. Locked pixels were left alone.");
  };

  const handleStamp = () => {
    if (!editor || !stamped) return;
    setEditor(applyPattern(editor, stamped));
    const added = stamped.added;
    clearImage();
    setMessage(
      added === 0
        ? "Image stamped. Locked pixels were left alone."
        : `Image stamped, ${added} ${added === 1 ? "colour" : "colours"} added. Locked pixels were left alone.`,
    );
  };

  // What the chip shows: a stamp being placed outranks a generator preview,
  // because the picture is the thing in hand. Either way the locked pixels are
  // drawn as they will stay, so the preview is the result and not a promise.
  const pattern =
    stamped ?? (preview && editor && patternFits(editor, preview) ? preview : null);
  const placing = Boolean(image && showImage);
  const shownPixels =
    editor && pattern ? previewPattern(editor, pattern) : editor?.pixels ?? new Uint8Array(0);
  const shownPalette = pattern?.palette ?? editor?.palette ?? [];

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
              <div className="nt-cluster chipswap-stage-head-end">
                <span className="nt-meta">
                  revision {selected.revision}
                  {selected.state === "published"
                    ? ` · ${selected.mintedCount} minted`
                    : editor.dirty
                      ? " · unsaved changes"
                      : ""}
                </span>
                <button
                  aria-pressed={centerlines}
                  className={cx("nt-button nt-button--sm", {
                    "nt-button--secondary": !centerlines,
                  })}
                  onClick={() => setCenterlines((shown) => !shown)}
                  title="Mark the middle row and column of the chip"
                  type="button"
                >
                  Centre lines
                </button>
              </div>
            </div>

            <ChipCanvas
              className="chipswap-editor-canvas"
              hoverPreview={editable && !placing ? hoverPreview : undefined}
              label={`${selected.title} artwork`}
              locks={editor.locks}
              onPaint={editable ? (placing ? handleDragImage : handlePaint) : undefined}
              palette={shownPalette}
              pixels={shownPixels}
              scale={12}
              showCenterlines={centerlines}
              showGrid
              underlay={
                placing && placement && image
                  ? { source: image.source, ...placement }
                  : null
              }
            />

            {pattern ? (
              <div className="nt-cluster">
                <span className="nt-tag nt-tag--warning">Preview</span>
                <button
                  className="nt-button nt-button--sm"
                  data-tid="chipswap-apply-pattern"
                  onClick={stamped ? handleStamp : handleApply}
                  type="button"
                >
                  {stamped ? "Stamp image" : "Apply pattern"}
                </button>
                <button
                  className="nt-button nt-button--ghost nt-button--sm"
                  onClick={stamped ? clearImage : () => setPreview(null)}
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
            <div className="chipswap-palette" ref={paletteRef}>
              <div className="chipswap-swatches">
                {editor.palette.map((colour, index) => (
                  <button
                    aria-pressed={editor.activeColor === index}
                    className={cx("chipswap-swatch", {
                      "chipswap-swatch--active": editor.activeColor === index,
                    })}
                    key={`${colour}-${index}`}
                    onClick={() => setEditor(selectColor(editor, index))}
                    style={swatchStyle(colour)}
                    title={colour}
                    type="button"
                  >
                    {index}
                  </button>
                ))}
                <button
                  aria-controls="chipswap-picker"
                  aria-expanded={picker}
                  aria-label="Add a colour"
                  className={cx("chipswap-swatch chipswap-swatch--add", {
                    "chipswap-swatch--active": picker,
                  })}
                  onClick={() => setPicker((open) => !open)}
                  title="Add a colour"
                  type="button"
                >
                  +
                </button>
              </div>
              {picker ? (
                <div className="chipswap-picker" id="chipswap-picker">
                  {full ? (
                    <p className="nt-meta">
                      The palette is full at {MAX_PALETTE} colours. Remove one to
                      make room.
                    </p>
                  ) : null}
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
                      disabled={full}
                      onClick={() => setEditor(addPaletteColor(editor, newColor))}
                      style={swatchStyle(newColor)}
                      type="button"
                    >
                      Add {newColor}
                    </button>
                  </div>
                  <div className="chipswap-blend">
                    <span className="nt-meta">Or blend two palette colours</span>
                    <label className="nt-field">
                      <span className="nt-label">From</span>
                      <select
                        className="nt-select chipswap-blend-select"
                        onChange={(event) => setBlendFrom(Number(event.currentTarget.value))}
                        style={swatchStyle(blendSource)}
                        value={blendFrom}
                      >
                        {editor.palette.map((colour, index) => (
                          <option key={index} style={swatchStyle(colour)} value={index}>
                            {index}: {colour}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="nt-field">
                      <span className="nt-label">To</span>
                      <select
                        className="nt-select chipswap-blend-select"
                        onChange={(event) => setBlendTo(Number(event.currentTarget.value))}
                        style={swatchStyle(blendTarget)}
                        value={blendTo}
                      >
                        {editor.palette.map((colour, index) => (
                          <option key={index} style={swatchStyle(colour)} value={index}>
                            {index}: {colour}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="nt-field">
                      <span className="nt-label">
                        Mix: {Math.round(blendRatio * 100)}%
                      </span>
                      <input
                        className="chipswap-range"
                        max={1}
                        min={0}
                        onChange={(event) => setBlendRatio(Number(event.currentTarget.value))}
                        step={0.05}
                        type="range"
                        value={blendRatio}
                      />
                    </label>
                    <button
                      className="nt-button nt-button--sm"
                      disabled={full}
                      onClick={() => setEditor(addPaletteColor(editor, blended))}
                      style={swatchStyle(blended)}
                      type="button"
                    >
                      Add {blended}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="nt-cluster">
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
                Remove colour {editor.activeColor}
              </button>
            </div>
          </section>

          <section className="nt-section">
            <h3 className="nt-section-title">Brush</h3>
            <div className="chipswap-brushes">
              {PRESET_BRUSHES.map((candidate) => brushButton(candidate))}
            </div>
            {customBrushes.length > 0 ? (
              <div className="chipswap-brush-custom">
                <div className="chipswap-brush-custom-head">
                  <span className="nt-label">Custom</span>
                  <button
                    aria-pressed={editingBrushes}
                    className="nt-button nt-button--ghost nt-button--sm"
                    onClick={() =>
                      editingBrushes ? stopEditingBrushes() : setEditingBrushes(true)
                    }
                    type="button"
                  >
                    {editingBrushes ? "Done" : "Edit"}
                  </button>
                </div>
                <div className="chipswap-brushes">
                  {customBrushes.map((candidate) => brushButton(candidate))}
                </div>
                {editingBrushes ? (
                  <>
                    <div className="nt-cluster">
                      <button
                        className="nt-button nt-button--danger nt-button--sm"
                        disabled={busy || markedBrushes.length === 0}
                        onClick={handleDeleteBrushes}
                        type="button"
                      >
                        {markedBrushes.length === 1
                          ? "Delete 1 brush"
                          : `Delete ${markedBrushes.length} brushes`}
                      </button>
                    </div>
                    <p className="nt-help">
                      Pick the brushes to delete. Deleting one is permanent.
                    </p>
                  </>
                ) : null}
              </div>
            ) : null}
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
            <h3 className="nt-section-title">Tool</h3>
            <div className="nt-segmented">
              {(Object.keys(TOOLS) as Tool[]).map((mode) => (
                <button
                  aria-pressed={tool === mode}
                  className={cx("nt-button nt-button--sm", {
                    "nt-button--secondary": tool !== mode,
                  })}
                  key={mode}
                  onClick={() => setTool(mode)}
                  type="button"
                >
                  {TOOLS[mode]}
                </button>
              ))}
            </div>
            {tool === "fill" ? (
              <p className="nt-help">
                Fill spreads from the pixel you click across every pixel of the
                same colour touching it, whatever the brush. Locked pixels stop
                it.
              </p>
            ) : null}
          </section>

          <section className="nt-section">
            <h3 className="nt-section-title">Locks</h3>
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
              Locked pixels are hatched and no action writes to them —
              generators and stamped pictures included.
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
                      style={swatchStyle(colour)}
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
              disabled={image !== null}
              onClick={handlePreview}
              title={image ? "Stamp or remove the picture first" : undefined}
              type="button"
            >
              Preview pattern
            </button>
          </section>

          <section className="nt-section">
            <h3 className="nt-section-title">Stamp an image</h3>
            {image ? (
              <>
                <label className="nt-field">
                  <span className="nt-label">Size: {Math.round(zoom * 100)}%</span>
                  <input
                    className="chipswap-range"
                    max={4}
                    min={0.2}
                    onChange={(event) => setZoom(Number(event.currentTarget.value))}
                    step={0.05}
                    type="range"
                    value={zoom}
                  />
                </label>
                {colourMax > 0 ? (
                  <label className="nt-field">
                    <span className="nt-label">
                      {stampBudget === 0
                        ? "Colours: the chip's own palette"
                        : `Colours from the picture: ${stampBudget}`}
                    </span>
                    <input
                      className="chipswap-range"
                      max={colourMax}
                      min={0}
                      onChange={(event) => setStampColors(Number(event.currentTarget.value))}
                      step={1}
                      type="range"
                      value={stampBudget}
                    />
                  </label>
                ) : (
                  <p className="nt-help">
                    The palette is full, so the picture is approximated with the
                    colours the chip already has.
                  </p>
                )}
                <div className="nt-cluster">
                  <button
                    className="nt-button nt-button--sm"
                    data-tid="chipswap-stamp"
                    onClick={handleStamp}
                    type="button"
                  >
                    Stamp
                  </button>
                  <button
                    aria-pressed={!showImage}
                    className={cx("nt-button nt-button--sm", {
                      "nt-button--secondary": showImage,
                    })}
                    onClick={() => setShowImage((shown) => !shown)}
                    type="button"
                  >
                    {showImage ? "Hide picture" : "Show picture"}
                  </button>
                  <button
                    className="nt-button nt-button--ghost nt-button--sm"
                    onClick={() => {
                      setZoom(1);
                      setOffset({ x: 0, y: 0 });
                    }}
                    type="button"
                  >
                    Recentre
                  </button>
                  <button
                    className="nt-button nt-button--ghost nt-button--sm"
                    onClick={clearImage}
                    type="button"
                  >
                    Remove
                  </button>
                </div>
                <p className="nt-help">
                  Drag the picture across the chip to place it. Every chip pixel
                  takes the average colour of the picture underneath it, and
                  locked pixels keep what they have. Source: {image.width} ×{" "}
                  {image.height} px.
                </p>
              </>
            ) : (
              <>
                <div className="nt-cluster">
                  <button
                    className="nt-button nt-button--sm"
                    data-tid="chipswap-choose-image"
                    disabled={busy}
                    onClick={() => fileRef.current?.click()}
                    type="button"
                  >
                    Choose a picture…
                  </button>
                  <button
                    className="nt-button nt-button--secondary nt-button--sm"
                    disabled={busy}
                    onClick={() => void handlePasteImage()}
                    type="button"
                  >
                    Paste
                  </button>
                </div>
                <input
                  accept="image/*"
                  aria-label="Picture to stamp"
                  className="chipswap-file"
                  onChange={handleChooseImage}
                  ref={fileRef}
                  type="file"
                />
                <p className="nt-help">
                  Or press Ctrl/Cmd+V with a picture on the clipboard. A chip is
                  31 pixels across, so what lands on it is an impression of the
                  picture rather than the picture.
                </p>
              </>
            )}
          </section>
        </aside>
      ) : null}
    </section>
  );
};
