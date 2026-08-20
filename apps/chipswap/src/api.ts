// Typed access to the Chipswap backend through preapproved self calls.
//
// Two properties of the kernel JSON bridge shape everything here: Nat and Int
// values travel as decimal strings, and an absent Motoko optional is omitted.
// Nanosecond timestamps stay strings because they do not fit a JS number
// exactly; only small counts become numbers.

import { querySelf, updateSelf, type JsonValue } from "neutron-tools/app";
import { PIXEL_COUNT } from "./chip.ts";
import { isHexColor } from "./palette.ts";
import type { NsfwRule, TradeRequirements } from "./requirements.ts";
import { serializeFilter } from "./market_filter.ts";
import type { MarketFilter } from "./market_filter.ts";

export type { NsfwRule, TradeRequirements, MarketFilter };

export class ChipswapError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChipswapError";
    this.code = code;
  }
}

export type Art = {
  shapeId: string;
  palette: string[];
  pixels: string;
};

export type DesignState = "draft" | "published";

export type Design = {
  designId: number;
  title: string;
  art: Art;
  state: DesignState;
  requirements: TradeRequirements;
  nsfw: boolean;
  revision: number;
  createdAtNs: string;
  publishedAtNs: string | null;
  mintedCount: number;
};

export type ChipState = "held" | "escrowed" | "uncertain";

export type Chip = {
  key: string;
  designer: string;
  designId: number;
  serial: number;
  title: string;
  art: Art;
  nsfw: boolean;
  designRevision: number;
  mintedAtNs: string;
  acquiredAtNs: string;
  state: ChipState;
  peer: string | null;
  requestId: string | null;
  contactName: string | null;
};

export type Status = {
  revision: number;
  canister: string;
  slotsUsed: number;
  slotLimit: number;
  draftCount: number;
  publishedCount: number;
  holdings: number;
  holdingsLimit: number;
  directoryCount: number;
  catalogDesigners: number;
  incomingPending: number;
  outgoingActive: number;
  crawl: CrawlProgress;
  shapeId: string;
  pixelCount: number;
  rowWidths: number[];
  paletteLimit: number;
  contactsAvailable: boolean;
};

export type DirectoryEntry = {
  canister: string;
  source: string;
  firstSeenNs: string;
  lastSeenNs: string;
  ignored: boolean;
  retired: boolean;
  strikes: number;
  lastCatalogNs: string | null;
  designCount: number;
  ownsChip: boolean;
  contactName: string | null;
};

// `remaining` counts designers this crawl has still to ask, so the tile can say
// how much is left rather than only how much is done. `full` says the directory
// hit its ceiling and further discoveries are being dropped.
export type CrawlProgress = {
  active: boolean;
  queried: number;
  discovered: number;
  remaining: number;
  full: boolean;
};

export type StoreRow = {
  designer: string;
  designId: number;
  title: string;
  art: Art;
  requirements: TradeRequirements;
  nsfw: boolean;
  designRevision: number;
  owned: boolean;
  fetchedAtNs: string;
  contactName: string | null;
};

export type IncomingTrade = {
  requestId: string;
  peer: string;
  wantDesignId: number;
  wantTitle: string;
  offered: Chip;
  state: "pending" | "accepted" | "declined";
  receivedAtNs: string;
  updatedAtNs: string;
  contactName: string | null;
};

export type OutgoingTrade = {
  requestId: string;
  peer: string;
  wantDesignId: number;
  offeredDesigner: string;
  offeredDesignId: number;
  offeredSerial: number;
  offeredTitle: string;
  offeredKey: string | null;
  state:
    | "sending"
    | "pending_designer"
    | "completed"
    | "declined"
    | "failed"
    | "uncertain";
  detail: string | null;
  createdAtNs: string;
  updatedAtNs: string;
  contactName: string | null;
};

export type BrushRecordRow = {
  id: number;
  name: string;
  width: number;
  height: number;
  anchor_x: number;
  anchor_y: number;
  cells: string;
};

export type Suggestion = {
  contactName: string;
  principal: string;
  inDirectory: boolean;
};

export type TradeOutcome = {
  requestId: string;
  outcome: string;
  revision: number;
};

// --- Primitive readers -----------------------------------------------------

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

export function natNumber(value: unknown, label = "number"): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`Value for ${label} is too large`);
    }
    return parsed;
  }
  throw new Error(`Invalid ${label}`);
}

/** Nanosecond stamps stay text: they exceed the exact range of a JS number. */
export function nsText(value: unknown, label = "timestamp"): string {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  throw new Error(`Invalid ${label}`);
}

function optionalNs(value: unknown, label = "timestamp"): string | null {
  return value === undefined || value === null ? null : nsText(value, label);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);
  return value;
}

function optionalText(value: unknown, label: string): string | null {
  return value === undefined || value === null ? null : text(value, label);
}

function optionalNat(value: unknown, label: string): number | null {
  return value === undefined || value === null ? null : natNumber(value, label);
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  const candidate = text(value, label);
  if (!(allowed as readonly string[]).includes(candidate)) {
    throw new Error(`Invalid ${label}`);
  }
  return candidate as T;
}

/**
 * Unwraps a Motoko result. The bridge may deliver a variant as `{ok: …}` /
 * `{err: …}` or flatten the successful payload, so both are accepted and an
 * error is raised as a typed rejection either way.
 */
function unwrap(value: unknown, label: string): Record<string, unknown> {
  const payload = record(value, label);
  const keys = Object.keys(payload);
  if (keys.length === 1 && keys[0] === "ok") {
    return record(payload.ok, label);
  }
  if (keys.length === 1 && keys[0] === "err") {
    const error = record(payload.err, label);
    throw new ChipswapError(
      typeof error.code === "string" ? error.code : "unknown",
      typeof error.message === "string" ? error.message : "The action failed.",
    );
  }
  if (
    keys.length === 2 &&
    keys.includes("code") &&
    keys.includes("message") &&
    typeof payload.code === "string"
  ) {
    throw new ChipswapError(payload.code, String(payload.message));
  }
  return payload;
}

// --- Parsers ---------------------------------------------------------------

export function parseArt(value: unknown): Art {
  const source = record(value, "chip art");
  const palette = source.palette;
  if (!Array.isArray(palette) || palette.length === 0) {
    throw new Error("Invalid chip palette");
  }
  const colors = palette.map((entry) => {
    const color = text(entry, "palette color");
    if (!isHexColor(color)) throw new Error("Invalid palette color");
    return color;
  });
  const pixels = text(source.pixels, "chip pixels");
  if (pixels.length !== PIXEL_COUNT * 2) throw new Error("Invalid chip pixels");
  return {
    shapeId: text(source.shape_id, "chip shape"),
    palette: colors,
    pixels,
  };
}

export function parseRequirements(value: unknown): TradeRequirements {
  const source = record(value, "trade requirements");
  return {
    approval: bool(source.approval, "approval flag"),
    minColors: optionalNat(source.min_colors, "color minimum"),
    maxCoverage: optionalNat(source.max_coverage, "coverage cap"),
    nsfw: oneOf(
      source.nsfw,
      ["any", "disallowed", "required"] as const,
      "NSFW rule",
    ),
  };
}

export function parseDesign(value: unknown): Design {
  const source = record(value, "design");
  return {
    designId: natNumber(source.design_id, "design id"),
    title: text(source.title, "design title"),
    art: parseArt(source.art),
    state: oneOf(source.state, ["draft", "published"] as const, "design state"),
    requirements: parseRequirements(source.requirements),
    nsfw: bool(source.nsfw, "NSFW tag"),
    revision: natNumber(source.revision, "design revision"),
    createdAtNs: nsText(source.created_at_ns, "created time"),
    publishedAtNs: optionalNs(source.published_at_ns, "published time"),
    mintedCount: natNumber(source.minted_count, "minted count"),
  };
}

export function parseChip(value: unknown): Chip {
  const source = record(value, "chip");
  return {
    key: text(source.key, "chip key"),
    designer: text(source.designer, "chip designer"),
    designId: natNumber(source.design_id, "design id"),
    serial: natNumber(source.serial, "serial"),
    title: text(source.title, "chip title"),
    art: parseArt(source.art),
    nsfw: bool(source.nsfw, "NSFW tag"),
    designRevision: natNumber(source.design_revision, "design revision"),
    mintedAtNs: nsText(source.minted_at_ns, "minted time"),
    acquiredAtNs: nsText(source.acquired_at_ns, "acquired time"),
    state: oneOf(
      source.state,
      ["held", "escrowed", "uncertain"] as const,
      "chip state",
    ),
    peer: optionalText(source.peer, "chip peer"),
    requestId: optionalText(source.request_id, "request id"),
    contactName: optionalText(source.contact_name, "contact name"),
  };
}

export function parseStatus(value: unknown): Status {
  const source = record(value, "status");
  const rowWidths = source.row_widths;
  if (!Array.isArray(rowWidths)) throw new Error("Invalid row widths");
  return {
    revision: natNumber(source.revision, "revision"),
    canister: text(source.canister, "canister id"),
    slotsUsed: natNumber(source.slots_used, "slots used"),
    slotLimit: natNumber(source.slot_limit, "slot limit"),
    draftCount: natNumber(source.draft_count, "draft count"),
    publishedCount: natNumber(source.published_count, "published count"),
    holdings: natNumber(source.holdings, "holdings"),
    holdingsLimit: natNumber(source.holdings_limit, "holdings limit"),
    directoryCount: natNumber(source.directory_count, "directory count"),
    catalogDesigners: natNumber(source.catalog_designers, "catalog designers"),
    incomingPending: natNumber(source.incoming_pending, "incoming pending"),
    outgoingActive: natNumber(source.outgoing_active, "outgoing active"),
    crawl: parseCrawlProgress(source.crawl),
    shapeId: text(source.shape_id, "shape id"),
    pixelCount: natNumber(source.pixel_count, "pixel count"),
    rowWidths: rowWidths.map((entry) => natNumber(entry, "row width")),
    paletteLimit: natNumber(source.palette_limit, "palette limit"),
    contactsAvailable: bool(source.contacts_available, "contacts availability"),
  };
}

export function parseDirectoryEntry(value: unknown): DirectoryEntry {
  const source = record(value, "directory entry");
  return {
    canister: text(source.canister, "canister id"),
    source: text(source.source, "directory source"),
    firstSeenNs: nsText(source.first_seen_ns, "first seen"),
    lastSeenNs: nsText(source.last_seen_ns, "last seen"),
    ignored: bool(source.ignored, "ignored flag"),
    retired: bool(source.retired, "retired flag"),
    strikes: natNumber(source.strikes, "strike count"),
    lastCatalogNs: optionalNs(source.last_catalog_ns, "last catalog"),
    designCount: natNumber(source.design_count, "design count"),
    ownsChip: bool(source.owns_chip, "ownership flag"),
    contactName: optionalText(source.contact_name, "contact name"),
  };
}

export function parseCrawlProgress(value: unknown): CrawlProgress {
  const source = record(value, "crawl progress");
  return {
    active: bool(source.active, "crawl activity"),
    queried: natNumber(source.queried, "queried count"),
    discovered: natNumber(source.discovered, "discovered count"),
    remaining: natNumber(source.remaining, "remaining count"),
    full: bool(source.full, "directory full flag"),
  };
}

export function parseStoreRow(value: unknown): StoreRow {
  const source = record(value, "store row");
  return {
    designer: text(source.designer, "designer"),
    designId: natNumber(source.design_id, "design id"),
    title: text(source.title, "title"),
    art: parseArt(source.art),
    requirements: parseRequirements(source.requirements),
    nsfw: bool(source.nsfw, "NSFW tag"),
    designRevision: natNumber(source.design_revision, "design revision"),
    owned: bool(source.owned, "owned flag"),
    fetchedAtNs: nsText(source.fetched_at_ns, "fetch time"),
    contactName: optionalText(source.contact_name, "contact name"),
  };
}

export function parseIncomingTrade(value: unknown): IncomingTrade {
  const source = record(value, "incoming trade");
  return {
    requestId: text(source.request_id, "request id"),
    peer: text(source.peer, "peer"),
    wantDesignId: natNumber(source.want_design_id, "design id"),
    wantTitle: text(source.want_title, "design title"),
    offered: parseChip(source.offered),
    state: oneOf(
      source.state,
      ["pending", "accepted", "declined"] as const,
      "trade state",
    ),
    receivedAtNs: nsText(source.received_at_ns, "received time"),
    updatedAtNs: nsText(source.updated_at_ns, "updated time"),
    contactName: optionalText(source.contact_name, "contact name"),
  };
}

export function parseOutgoingTrade(value: unknown): OutgoingTrade {
  const source = record(value, "outgoing trade");
  return {
    requestId: text(source.request_id, "request id"),
    peer: text(source.peer, "peer"),
    wantDesignId: natNumber(source.want_design_id, "design id"),
    offeredDesigner: text(source.offered_designer, "offered designer"),
    offeredDesignId: natNumber(source.offered_design_id, "offered design id"),
    offeredSerial: natNumber(source.offered_serial, "offered serial"),
    offeredTitle: text(source.offered_title, "offered title"),
    offeredKey: optionalText(source.offered_key, "offered key"),
    state: oneOf(
      source.state,
      [
        "sending",
        "pending_designer",
        "completed",
        "declined",
        "failed",
        "uncertain",
      ] as const,
      "trade state",
    ),
    detail: optionalText(source.detail, "detail"),
    createdAtNs: nsText(source.created_at_ns, "created time"),
    updatedAtNs: nsText(source.updated_at_ns, "updated time"),
    contactName: optionalText(source.contact_name, "contact name"),
  };
}

export function parseBrushRow(value: unknown): BrushRecordRow {
  const source = record(value, "brush");
  return {
    id: natNumber(source.id, "brush id"),
    name: text(source.name, "brush name"),
    width: natNumber(source.width, "brush width"),
    height: natNumber(source.height, "brush height"),
    anchor_x: natNumber(source.anchor_x, "brush anchor"),
    anchor_y: natNumber(source.anchor_y, "brush anchor"),
    cells: text(source.cells, "brush cells"),
  };
}

export function parseSuggestion(value: unknown): Suggestion {
  const source = record(value, "suggestion");
  return {
    contactName: text(source.contact_name, "contact name"),
    principal: text(source.principal, "principal"),
    inDirectory: bool(source.in_directory, "directory flag"),
  };
}

function parseTradeOutcome(value: unknown): TradeOutcome {
  const source = unwrap(value, "trade result");
  return {
    requestId: text(source.request_id, "request id"),
    outcome: text(source.outcome, "outcome"),
    revision: natNumber(source.revision, "revision"),
  };
}

function parseRevision(value: unknown): number {
  return natNumber(unwrap(value, "result").revision, "revision");
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

// --- Calls -----------------------------------------------------------------

const NO_ARGUMENT = [null] as unknown as JsonValue[];

export async function loadStatus(): Promise<Status> {
  return parseStatus(await querySelf("chipswap_status", NO_ARGUMENT));
}

export async function loadDesigns(): Promise<Design[]> {
  const value = await querySelf("chipswap_designs", NO_ARGUMENT);
  return list(value, "design list").map(parseDesign);
}

export async function loadDesign(designId: number): Promise<Design | null> {
  const value = await querySelf("chipswap_design", [
    { design_id: String(designId) },
  ] as unknown as JsonValue[]);
  return value === null || value === undefined ? null : parseDesign(value);
}

export async function loadCollection(
  offset: number,
  limit: number,
): Promise<{ chips: Chip[]; total: number }> {
  const value = record(
    await querySelf("chipswap_collection", [
      { offset: String(offset), limit: String(limit) },
    ] as unknown as JsonValue[]),
    "collection",
  );
  return {
    chips: list(value.chips, "chip list").map(parseChip),
    total: natNumber(value.total, "total"),
  };
}

export async function loadDirectory(
  offset: number,
  limit: number,
): Promise<{ entries: DirectoryEntry[]; total: number }> {
  const value = record(
    await querySelf("chipswap_directory", [
      { offset: String(offset), limit: String(limit) },
    ] as unknown as JsonValue[]),
    "directory",
  );
  return {
    entries: list(value.entries, "directory list").map(parseDirectoryEntry),
    total: natNumber(value.total, "total"),
  };
}

// Named for `chipswap_store`, the backend method it wraps. The page it reads is
// the Market, and the backend route keeps the older name.
export async function loadStore(
  filter: MarketFilter,
  offset: number,
  limit: number,
): Promise<{ rows: StoreRow[]; total: number; nsfwHidden: number }> {
  const value = record(
    await querySelf("chipswap_store", [
      {
        ...serializeFilter(filter),
        offset: String(offset),
        limit: String(limit),
      },
    ] as unknown as JsonValue[]),
    "market page",
  );
  return {
    rows: list(value.rows, "store rows").map(parseStoreRow),
    total: natNumber(value.total, "total"),
    nsfwHidden: natNumber(value.nsfw_hidden, "hidden count"),
  };
}

export async function loadTrades(): Promise<{
  incoming: IncomingTrade[];
  outgoing: OutgoingTrade[];
}> {
  const value = record(await querySelf("chipswap_trades", NO_ARGUMENT), "trades");
  return {
    incoming: list(value.incoming, "incoming trades").map(parseIncomingTrade),
    outgoing: list(value.outgoing, "outgoing trades").map(parseOutgoingTrade),
  };
}

export async function loadBrushes(): Promise<BrushRecordRow[]> {
  const value = await querySelf("chipswap_brushes", NO_ARGUMENT);
  return list(value, "brush list").map(parseBrushRow);
}

export async function loadSuggestions(
  searchText: string,
  offset: number,
  limit: number,
): Promise<{ rows: Suggestion[]; total: number; available: boolean }> {
  const value = record(
    await querySelf("chipswap_contacts_suggestions", [
      { search_text: searchText, offset: String(offset), limit: String(limit) },
    ] as unknown as JsonValue[]),
    "suggestions",
  );
  return {
    rows: list(value.rows, "suggestion list").map(parseSuggestion),
    total: natNumber(value.total, "total"),
    available: bool(value.available, "availability"),
  };
}

export async function createDraft(title: string): Promise<number> {
  const value = unwrap(
    await updateSelf("chipswap_draft_create", [{ title }] as unknown as JsonValue[]),
    "draft",
  );
  return natNumber(value.design_id, "design id");
}

export async function saveDraft(input: {
  designId: number;
  expectedRevision: number;
  title: string;
  palette: string[];
  pixels: string;
}): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_draft_save", [
      {
        design_id: String(input.designId),
        expected_revision: String(input.expectedRevision),
        title: input.title,
        palette: input.palette,
        pixels: input.pixels,
      },
    ] as unknown as JsonValue[]),
  );
}

export async function deleteDraft(designId: number): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_draft_delete", [
      { design_id: String(designId) },
    ] as unknown as JsonValue[]),
  );
}

/** An unset requirement is left out of the record entirely, which is how an
 *  optional Nat travels: a sentinel number would be a requirement. */
function policyFields(policy: TradePolicy): Record<string, JsonValue> {
  return {
    approval: policy.requirements.approval,
    ...(policy.requirements.minColors === null
      ? {}
      : { min_colors: String(policy.requirements.minColors) }),
    ...(policy.requirements.maxCoverage === null
      ? {}
      : { max_coverage: String(policy.requirements.maxCoverage) }),
    nsfw_rule: policy.requirements.nsfw,
    nsfw: policy.nsfw,
  } as unknown as Record<string, JsonValue>;
}

/** What a design asks in exchange, and whether it wears the tag itself. */
export type TradePolicy = {
  requirements: TradeRequirements;
  nsfw: boolean;
};

export async function publishDesign(
  input: { designId: number; expectedRevision: number } & TradePolicy,
): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_publish", [
      {
        design_id: String(input.designId),
        expected_revision: String(input.expectedRevision),
        ...policyFields(input),
      },
    ] as unknown as JsonValue[]),
  );
}

export async function setTradePolicy(
  designId: number,
  policy: TradePolicy,
): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_set_trade_policy", [
      { design_id: String(designId), ...policyFields(policy) },
    ] as unknown as JsonValue[]),
  );
}

export async function addDirectoryEntry(
  canister: string,
  source: "manual" | "contacts",
): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_directory_add", [
      { canister, source },
    ] as unknown as JsonValue[]),
  );
}

export async function removeDirectoryEntry(canister: string): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_directory_remove", [
      { canister },
    ] as unknown as JsonValue[]),
  );
}

// An ignored designer stays in the directory, so this is a flag on an entry
// rather than a removal: forgetting them would let the next crawl put them back
// with no memory of the decision.
export async function setDirectoryIgnored(
  canister: string,
  ignored: boolean,
): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_directory_set_ignored", [
      { canister, ignored },
    ] as unknown as JsonValue[]),
  );
}

// Retirement is a conclusion the canister drew from calls that went unanswered.
// The owner may set it or clear it: clear it for a designer whose canister was
// only stopped, set it for one they know is gone.
export async function setDirectoryRetired(
  canister: string,
  retired: boolean,
): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_directory_set_retired", [
      { canister, retired },
    ] as unknown as JsonValue[]),
  );
}

export async function saveBrush(input: {
  id: number | null;
  name: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  cells: string;
}): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_brush_save", [
      {
        ...(input.id === null ? {} : { id: String(input.id) }),
        name: input.name,
        width: String(input.width),
        height: String(input.height),
        anchor_x: String(input.anchorX),
        anchor_y: String(input.anchorY),
        cells: input.cells,
      },
    ] as unknown as JsonValue[]),
  );
}

export async function deleteBrush(id: number): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_brush_delete", [
      { id: String(id) },
    ] as unknown as JsonValue[]),
  );
}

export async function forgetTrade(requestId: string): Promise<number> {
  return parseRevision(
    await updateSelf("chipswap_trade_forget", [
      { request_id: requestId },
    ] as unknown as JsonValue[]),
  );
}

// A crawl runs in rounds the tile drives, so that a long one shows its progress
// and can be stopped. Starting clears any earlier crawl: one that finished has
// visited everyone, and continuing it would do nothing.
export async function startCrawl(): Promise<CrawlProgress> {
  return parseCrawlProgress(
    unwrap(await updateSelf("chipswap_crawl_start", NO_ARGUMENT), "crawl start"),
  );
}

export async function crawlStep(): Promise<CrawlProgress> {
  return parseCrawlProgress(
    unwrap(await updateSelf("chipswap_crawl_step", NO_ARGUMENT), "crawl step"),
  );
}

export async function stopCrawl(): Promise<CrawlProgress> {
  return parseCrawlProgress(
    unwrap(await updateSelf("chipswap_crawl_stop", NO_ARGUMENT), "crawl stop"),
  );
}

export async function fetchCatalogs(
  canisters: string[],
): Promise<{ fetched: string[]; failed: string[]; retired: string[] }> {
  const value = unwrap(
    await updateSelf("chipswap_fetch_catalogs", [
      { canisters },
    ] as unknown as JsonValue[]),
    "catalog refresh",
  );
  return {
    fetched: list(value.fetched, "fetched list").map((entry) =>
      text(entry, "canister id"),
    ),
    failed: list(value.failed, "failed list").map((entry) =>
      text(entry, "canister id"),
    ),
    retired: list(value.retired, "retired list").map((entry) =>
      text(entry, "canister id"),
    ),
  };
}

export async function proposeTrade(input: {
  peer: string;
  wantDesignId: number;
  offer:
    | { kind: "own"; designId: number }
    | { kind: "held"; chipKey: string };
}): Promise<TradeOutcome> {
  return parseTradeOutcome(
    await updateSelf("chipswap_trade_propose", [
      {
        peer: input.peer,
        want_design_id: String(input.wantDesignId),
        offer_kind: input.offer.kind,
        ...(input.offer.kind === "own"
          ? { offer_design_id: String(input.offer.designId) }
          : { offer_chip_key: input.offer.chipKey }),
      },
    ] as unknown as JsonValue[]),
  );
}

export async function resolveTrade(requestId: string): Promise<TradeOutcome> {
  return parseTradeOutcome(
    await updateSelf("chipswap_trade_resolve", [
      { request_id: requestId },
    ] as unknown as JsonValue[]),
  );
}

export async function acceptTrade(requestId: string): Promise<TradeOutcome> {
  return parseTradeOutcome(
    await updateSelf("chipswap_trade_accept", [
      { request_id: requestId },
    ] as unknown as JsonValue[]),
  );
}

export async function declineTrade(requestId: string): Promise<TradeOutcome> {
  return parseTradeOutcome(
    await updateSelf("chipswap_trade_decline", [
      { request_id: requestId },
    ] as unknown as JsonValue[]),
  );
}

// --- Display helpers --------------------------------------------------------

/** Nanoseconds since the epoch as a local date-time, without losing precision. */
export function formatTimestamp(ns: string): string {
  try {
    const milliseconds = Number(BigInt(ns) / 1_000_000n);
    if (!Number.isFinite(milliseconds)) return "unknown";
    return new Date(milliseconds).toLocaleString();
  } catch {
    return "unknown";
  }
}

export function shortPrincipal(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-5)}`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ChipswapError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | null {
  return error instanceof ChipswapError ? error.code : null;
}
