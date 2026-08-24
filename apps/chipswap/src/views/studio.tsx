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
  setTradePolicy,
  type Design,
  type Status,
  type TradePolicy,
} from "../api.ts";
import { TradePolicyFields } from "../trade_policy.tsx";
import { openRequirements } from "../requirements.ts";
import {
  PRESET_BRUSHES,
  blankBrush,
  brushCoverage,
  brushFromRecord,
  brushIsEmpty,
  toggleBrushCell,
  stamp,
  type Brush,
} from "../brushes.ts";
import { BrushGlyph } from "../brush_glyph.tsx";
import { ChipCanvas } from "../chip_canvas.tsx";
import { decodePixels, encodePixels } from "../chip.ts";
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
  patternShowing,
  previewPattern,
  redo,
  removePaletteColor,
  selectColor,
  undo,
  unlockAll,
  type EditorState,
  type Pattern,
} from "../editor_state.ts";
import { buildStamp, coverPlacement } from "../image_stamp.ts";
import { clipboardImage, loadImage, type LoadedImage } from "../image_source.ts";
import { GENERATORS, renderGenerator, type GeneratorId } from "../patterns.ts";
import { MAX_PALETTE, blendColors, contrastColor } from "../palette.ts";

type Tool = "paint" | "lock" | "unlock";

const TOOLS: Record<Tool, string> = {
  paint: "Paint",
  lock: "Lock",
  unlock: "Unlock",
};

/** Paints a control in the color it stands for, with a legible label on top. */
const swatchStyle = (color: string) => ({
  background: color,
  color: contrastColor(color),
});

/**
 * A stamp that has been committed, with everything needed to put the picture
 * back the way it was: the placement it was stamped at, and the art it left
 * behind, which is how an undo is recognized as undoing this stamp.
 */
type StampBack = {
  image: LoadedImage;
  zoom: number;
  offset: { x: number; y: number };
  colors: number;
  art: Pattern;
};

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
  // The last stamp, kept so undo can hand the picture back rather than only
  // taking the paint away: a stamp that missed is worth another go from where
  // it was, not from the beginning.
  const [stampBack, setStampBack] = useState<StampBack | null>(null);
  // The policy being edited: what a publish would set, or what a published
  // design's controls are showing before they are applied.
  const [policy, setPolicy] = useState<TradePolicy>({
    requirements: openRequirements(),
    nsfw: false,
  });
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dragFrom = useRef<{ x: number; y: number } | null>(null);

  const selected = designs.find((design) => design.designId === selectedId) ?? null;
  const editable = selected?.state === "draft";
  // A full palette can take no more colors, so the flyout has nothing to offer.
  const full = (editor?.palette.length ?? 0) >= MAX_PALETTE;
  // The blend ends fall back to black and white so the flyout still renders
  // while a design is loading and the palette is not there yet.
  const blendSource = editor?.palette[blendFrom] ?? "#000000";
  const blendTarget = editor?.palette[blendTo] ?? "#ffffff";
  const blended = blendColors(blendSource, blendTarget, blendRatio);
  // A published design's controls start as its stored policy, so the save
  // button has nothing to do until something has actually moved.
  const policyChanged =
    selected !== null &&
    (policy.nsfw !== selected.nsfw ||
      policy.requirements.approval !== selected.requirements.approval ||
      policy.requirements.minColors !== selected.requirements.minColors ||
      policy.requirements.maxCoverage !== selected.requirements.maxCoverage ||
      policy.requirements.nsfw !== selected.requirements.nsfw);

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
    setStampBack(null);
    setPicker(false);
    setConfirmPublish(false);
    setPolicy({ requirements: selected.requirements, nsfw: selected.nsfw });
  }, [selected?.designId, selected?.revision, selected?.state]);

  // The color flyout dismisses like any menu: Escape, or a press that lands
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
  // palette puts it away rather than leaving it to be read against colors it
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

  // Unlock is the one tool that reaches through locks, because a wall it
  // exists to take down cannot also be what stops it.
  const covered = useCallback(
    (state: EditorState, x: number, y: number): number[] =>
      brushCoverage(brush, state.pixels, state.locks, x, y, {
        throughLocks: tool === "unlock",
      }),
    [brush, tool],
  );

  // A drag is one edit: the first cell opens the stroke and the rest extend it,
  // so undo steps back over the whole line rather than one pixel at a time.
  const handlePaint = (x: number, y: number, phase: "start" | "move" | "end") => {
    if (!editor || !editable) return;
    if (phase === "end") {
      setEditor((current) => (current ? endStroke(current) : current));
      return;
    }
    if (brush.kind === "flood") {
      // One click, one fill: a drag over the region it just covered must not
      // stack an undo entry for every pixel the pointer crosses.
      if (phase !== "start") return;
      setPreview(null);
      setEditor((current) => {
        if (!current) return current;
        const region = covered(current, x, y);
        if (region.length === 0) return current;
        if (tool === "paint") {
          return paint(current, region, current.activeColor);
        }
        return paintLocks(current, region, tool === "lock");
      });
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
      // A flood brush outlines the region itself, so a fill shows how far it
      // would run before it runs. A mask brush outlines its own cells.
      const cells = covered(editor, x, y);
      if (cells.length === 0) return null;
      if (tool === "paint") {
        return {
          cells,
          changes: cells.filter((index) => editor.locks[index] !== 1),
          color: ink,
        };
      }
      // Locking only changes an unlocked pixel, unlocking only a locked one.
      const changeable = tool === "lock" ? 0 : 1;
      return {
        cells,
        changes: cells.filter((index) => editor.locks[index] === changeable),
        color: "#f2f5f7",
      };
    },
    [covered, editor, tool],
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
      setStampBack(null);
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
        requirements: policy.requirements,
        nsfw: policy.nsfw,
      });
      setConfirmPublish(false);
      await reload();
      setMessage("Published. This chip is now public and permanent.");
    });

  const handleTradePolicy = () =>
    run(async () => {
      if (!selected) return;
      await setTradePolicy(selected.designId, policy);
      await reload();
      setMessage("Trade requirements saved.");
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
  // The palette decides how much of the picture can survive: colors it cannot
  // add are colors the picture has to do without.
  const room = MAX_PALETTE - (editor?.palette.length ?? MAX_PALETTE);
  const colorMax = Math.min(32, Math.max(0, room));
  const stampBudget = Math.min(stampColors, colorMax);
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
      setFailure("Choose at least one palette color for the generator.");
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
    if (!editor || !image || !stamped) return;
    const next = applyPattern(editor, stamped);
    setEditor(next);
    // Remembered only when the stamp is a step in the history. A stamp that
    // changed nothing leaves no step to undo, so there is nothing to come back
    // from and a memory of it could only be triggered by somebody else's undo.
    setStampBack(
      next === editor
        ? null
        : {
            image,
            zoom,
            offset,
            colors: stampColors,
            art: { pixels: next.pixels, palette: next.palette },
          },
    );
    const added = stamped.added;
    clearImage();
    setMessage(
      added === 0
        ? "Image stamped. Locked pixels were left alone."
        : `Image stamped, ${added} ${added === 1 ? "color" : "colors"} added. Locked pixels were left alone.`,
    );
  };

  // Undo takes the paint off; if the step it took off was a stamp, it also puts
  // the picture back where it was, so a stamp that came out wrong can be nudged
  // and tried again rather than set up from scratch.
  const handleUndo = () => {
    if (!editor) return;
    setEditor(undo(editor));
    if (!stampBack || !patternShowing(editor, stampBack.art)) return;
    setImage(stampBack.image);
    setZoom(stampBack.zoom);
    setOffset(stampBack.offset);
    setStampColors(stampBack.colors);
    setShowImage(true);
    setPreview(null);
    setMessage("Stamp undone. The picture is back where it was.");
  };

  // The other half of that: redoing the stamp commits the picture again, so it
  // comes off the table the way stamping took it off in the first place.
  const handleRedo = () => {
    if (!editor) return;
    const next = redo(editor);
    setEditor(next);
    if (stampBack && patternShowing(next, stampBack.art)) clearImage();
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
                  {design.nsfw ? (
                    <span className="nt-tag nt-tag--warning">NSFW</span>
                  ) : null}
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
                  Center lines
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
                  onClick={handleUndo}
                  type="button"
                >
                  Undo
                </button>
                <button
                  className="nt-button nt-button--ghost nt-button--sm"
                  disabled={!editor.canRedo}
                  onClick={handleRedo}
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
              <div className="chipswap-policy-panel">
                <span className="nt-meta">
                  Published art is permanent. What you ask for it stays yours to
                  change, and so does the tag.
                </span>
                <TradePolicyFields
                  disabled={busy}
                  label="Trade requirements"
                  onChange={setPolicy}
                  policy={policy}
                />
                <div className="nt-toolbar chipswap-actions">
                  <button
                    className="nt-button nt-button--sm"
                    data-tid="chipswap-save-policy"
                    disabled={busy || !policyChanged}
                    onClick={() => void handleTradePolicy()}
                    type="button"
                  >
                    Save requirements
                  </button>
                  <button
                    className="nt-button nt-button--ghost nt-button--sm"
                    disabled={busy || !policyChanged}
                    onClick={() =>
                      setPolicy({
                        requirements: selected.requirements,
                        nsfw: selected.nsfw,
                      })
                    }
                    type="button"
                  >
                    Discard changes
                  </button>
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
                <p className="nt-meta">
                  Ask for whatever you like in exchange, or nothing at all — an
                  offer that fails a requirement is refused before it reaches
                  you. These stay changeable after publishing.
                </p>
                <TradePolicyFields
                  disabled={busy}
                  label="Trade requirements for this design"
                  onChange={setPolicy}
                  policy={policy}
                />
                <div className="nt-cluster">
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
                {editor.palette.map((color, index) => (
                  <button
                    aria-pressed={editor.activeColor === index}
                    className={cx("chipswap-swatch", {
                      "chipswap-swatch--active": editor.activeColor === index,
                    })}
                    key={`${color}-${index}`}
                    onClick={() => setEditor(selectColor(editor, index))}
                    style={swatchStyle(color)}
                    title={color}
                    type="button"
                  >
                    {index}
                  </button>
                ))}
                <button
                  aria-controls="chipswap-picker"
                  aria-expanded={picker}
                  aria-label="Add a color"
                  className={cx("chipswap-swatch chipswap-swatch--add", {
                    "chipswap-swatch--active": picker,
                  })}
                  onClick={() => setPicker((open) => !open)}
                  title="Add a color"
                  type="button"
                >
                  +
                </button>
              </div>
              {picker ? (
                <div className="chipswap-picker" id="chipswap-picker">
                  {full ? (
                    <p className="nt-meta">
                      The palette is full at {MAX_PALETTE} colors. Remove one to
                      make room.
                    </p>
                  ) : null}
                  <div className="nt-cluster">
                    <input
                      aria-label="New color"
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
                    <span className="nt-meta">Or blend two palette colors</span>
                    <label className="nt-field">
                      <span className="nt-label">From</span>
                      <select
                        className="nt-select chipswap-blend-select"
                        onChange={(event) => setBlendFrom(Number(event.currentTarget.value))}
                        style={swatchStyle(blendSource)}
                        value={blendFrom}
                      >
                        {editor.palette.map((color, index) => (
                          <option key={index} style={swatchStyle(color)} value={index}>
                            {index}: {color}
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
                        {editor.palette.map((color, index) => (
                          <option key={index} style={swatchStyle(color)} value={index}>
                            {index}: {color}
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
                    ? "Remove this color"
                    : "This color is still on the chip"
                }
                type="button"
              >
                Remove color {editor.activeColor}
              </button>
            </div>
          </section>

          <section className="nt-section">
            <h3 className="nt-section-title">Brush</h3>
            <div className="chipswap-brushes">
              {PRESET_BRUSHES.map((candidate) => brushButton(candidate))}
            </div>
            {brush.kind === "flood" ? (
              <p className="nt-help">
                Fill spreads from the pixel you click across every pixel of the
                same color touching it, and the tool decides what happens to
                them. Locked pixels stop it — except under Unlock, which
                spreads through them to give the region back.
              </p>
            ) : null}
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
          </section>

          <section className="nt-section">
            <h3 className="nt-section-title">Locks</h3>
            <div className="nt-cluster">
              <button
                className="nt-button nt-button--sm"
                onClick={() => setEditor(lockAllOfColor(editor, editor.activeColor))}
                type="button"
              >
                Lock all of color {editor.activeColor}
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
              <legend className="nt-label">Colors, in band order</legend>
              <div className="chipswap-swatches">
                {editor.palette.map((color, index) => {
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
                      style={swatchStyle(color)}
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
                {colorMax > 0 ? (
                  <label className="nt-field">
                    <span className="nt-label">
                      {stampBudget === 0
                        ? "Colors: the chip's own palette"
                        : `Colors from the picture: ${stampBudget}`}
                    </span>
                    <input
                      className="chipswap-range"
                      max={colorMax}
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
                    colors the chip already has.
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
                    Recenter
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
                  takes the average color of the picture underneath it, and
                  locked pixels keep what they have. Undo hands the picture back
                  where it was, so a stamp can be nudged and tried again. Source:{" "}
                  {image.width} × {image.height} px.
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
