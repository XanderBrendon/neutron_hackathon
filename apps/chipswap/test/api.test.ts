import { expect, test } from "bun:test";
import { PIXEL_COUNT } from "../src/chip.ts";
import {
  ChipswapError,
  errorCode,
  formatTimestamp,
  natNumber,
  nsText,
  parseArt,
  parseChip,
  parseDesign,
  parseDirectoryEntry,
  parseIncomingTrade,
  parseOutgoingTrade,
  parseStatus,
  parseRequirements,
  parseStoreRow,
  parseSuggestion,
  shortPrincipal,
} from "../src/api.ts";

const PIXELS = "00".repeat(PIXEL_COUNT);

const ART = {
  shape_id: "circle31",
  palette: ["#000000", "#ffffff"],
  pixels: PIXELS,
};

const OPEN_REQUIREMENTS = { approval: false, nsfw: "any" };

const CHIP = {
  key: "aaaaa-aa.1.2",
  designer: "aaaaa-aa",
  design_id: "1",
  serial: "2",
  title: "Sunrise",
  art: ART,
  nsfw: false,
  design_revision: "3",
  minted_at_ns: "1700000000000000000",
  acquired_at_ns: "1700000000000000001",
  state: "held",
};

test("Nat values arrive as decimal strings", () => {
  expect(natNumber("42")).toBe(42);
  expect(natNumber(42)).toBe(42);
  expect(natNumber("0")).toBe(0);
  expect(() => natNumber("x")).toThrow();
  expect(() => natNumber("-1")).toThrow();
  expect(() => natNumber(1.5)).toThrow();
  expect(() => natNumber(null)).toThrow();
  expect(() => natNumber("99999999999999999999")).toThrow();
});

test("nanosecond stamps keep full precision as text", () => {
  const exact = "1700000000123456789";
  expect(nsText(exact)).toBe(exact);
  // The same value through a JS number would round; the string must not.
  expect(Number(exact).toString()).not.toBe(exact);
  expect(() => nsText("later")).toThrow();
});

test("art is validated before it reaches the canvas", () => {
  expect(parseArt(ART).palette).toEqual(["#000000", "#ffffff"]);
  expect(() => parseArt({ ...ART, pixels: "00" })).toThrow();
  expect(() => parseArt({ ...ART, palette: [] })).toThrow();
  expect(() => parseArt({ ...ART, palette: ["#FFFFFF"] })).toThrow();
  expect(() => parseArt({ ...ART, palette: ["white"] })).toThrow();
  expect(() => parseArt(null)).toThrow();
});

test("an unset requirement arrives as an absent field, not a sentinel", () => {
  // Motoko omits a null optional entirely, so a requirement that is off is a
  // field that is not there rather than a zero that would read as a limit.
  expect(parseRequirements(OPEN_REQUIREMENTS)).toEqual({
    approval: false,
    minColors: null,
    maxCoverage: null,
    nsfw: "any",
  });
  expect(
    parseRequirements({
      approval: true,
      min_colors: "6",
      max_coverage: "40",
      nsfw: "disallowed",
    }),
  ).toEqual({
    approval: true,
    minColors: 6,
    maxCoverage: 40,
    nsfw: "disallowed",
  });
  // A rule that is not one of the three is refused rather than read as "any".
  expect(() =>
    parseRequirements({ ...OPEN_REQUIREMENTS, nsfw: "maybe" }),
  ).toThrow();
  expect(() => parseRequirements({ approval: false })).toThrow();
  expect(() =>
    parseRequirements({ ...OPEN_REQUIREMENTS, min_colors: "x" }),
  ).toThrow();
});

test("designs parse with their optional publication time", () => {
  const draft = parseDesign({
    design_id: "1",
    title: "Sunrise",
    art: ART,
    state: "draft",
    requirements: OPEN_REQUIREMENTS,
    nsfw: false,
    revision: "2",
    created_at_ns: "100",
    minted_count: "0",
  });
  expect(draft.designId).toBe(1);
  expect(draft.state).toBe("draft");
  expect(draft.publishedAtNs).toBeNull();
  expect(draft.requirements.minColors).toBeNull();

  const published = parseDesign({
    design_id: "1",
    title: "Sunrise",
    art: ART,
    state: "published",
    requirements: {
      approval: true,
      min_colors: "4",
      max_coverage: "60",
      nsfw: "required",
    },
    nsfw: true,
    revision: "2",
    created_at_ns: "100",
    published_at_ns: "200",
    minted_count: "5",
  });
  expect(published.publishedAtNs).toBe("200");
  expect(published.requirements).toEqual({
    approval: true,
    minColors: 4,
    maxCoverage: 60,
    nsfw: "required",
  });
  expect(published.nsfw).toBe(true);
  expect(published.mintedCount).toBe(5);

  expect(() => parseDesign({ ...draft, state: "archived" })).toThrow();
});

test("chips carry their trade state and optional escrow details", () => {
  const held = parseChip(CHIP);
  expect(held.state).toBe("held");
  expect(held.peer).toBeNull();
  expect(held.requestId).toBeNull();
  expect(held.contactName).toBeNull();

  const escrowed = parseChip({
    ...CHIP,
    state: "escrowed",
    peer: "aaaaa-aa",
    request_id: "0f",
    contact_name: "Ada",
  });
  expect(escrowed.state).toBe("escrowed");
  expect(escrowed.peer).toBe("aaaaa-aa");
  expect(escrowed.requestId).toBe("0f");
  expect(escrowed.contactName).toBe("Ada");

  expect(() => parseChip({ ...CHIP, state: "gone" })).toThrow();
});

test("status reports the geometry the editor draws with", () => {
  const status = parseStatus({
    revision: "7",
    canister: "aaaaa-aa",
    slots_used: "3",
    slot_limit: "10",
    draft_count: "1",
    published_count: "2",
    holdings: "4",
    holdings_limit: "500",
    directory_count: "5",
    catalog_designers: "2",
    incoming_pending: "1",
    outgoing_active: "0",
    auto_announce: false,
    shape_id: "circle31",
    pixel_count: "757",
    row_widths: ["9", "13"],
    palette_limit: "64",
    contacts_available: true,
  });

  expect(status.slotsUsed).toBe(3);
  expect(status.pixelCount).toBe(757);
  expect(status.rowWidths).toEqual([9, 13]);
  expect(status.contactsAvailable).toBe(true);
  expect(status.autoAnnounce).toBe(false);
});

test("directory and store rows carry the ownership flags the filters use", () => {
  const entry = parseDirectoryEntry({
    canister: "aaaaa-aa",
    source: "trade",
    first_seen_ns: "1",
    last_seen_ns: "2",
    announced: true,
    design_count: "3",
    owns_chip: false,
  });
  expect(entry.announced).toBe(true);
  expect(entry.lastCatalogNs).toBeNull();
  expect(entry.ownsChip).toBe(false);

  const row = parseStoreRow({
    designer: "aaaaa-aa",
    design_id: "2",
    title: "Peer chip",
    art: ART,
    requirements: { approval: false, min_colors: "3", nsfw: "any" },
    nsfw: true,
    design_revision: "1",
    owned: true,
    owns_designer: true,
    fetched_at_ns: "9",
    contact_name: "Grace",
  });
  expect(row.owned).toBe(true);
  expect(row.ownsDesigner).toBe(true);
  expect(row.contactName).toBe("Grace");
  // The row carries the whole policy, because the store pre-checks an offer
  // against it before paying for a call.
  expect(row.requirements.minColors).toBe(3);
  expect(row.requirements.maxCoverage).toBeNull();
  expect(row.nsfw).toBe(true);
});

test("trades parse in both directions", () => {
  const incoming = parseIncomingTrade({
    request_id: "0a0b",
    peer: "aaaaa-aa",
    want_design_id: "1",
    want_title: "Sunrise",
    offered: CHIP,
    state: "pending",
    received_at_ns: "1",
    updated_at_ns: "2",
  });
  expect(incoming.state).toBe("pending");
  expect(incoming.offered.serial).toBe(2);
  expect(incoming.offered.nsfw).toBe(false);

  const outgoing = parseOutgoingTrade({
    request_id: "0a0b",
    peer: "aaaaa-aa",
    want_design_id: "1",
    offered_designer: "aaaaa-aa",
    offered_design_id: "2",
    offered_serial: "3",
    offered_title: "Mine",
    state: "uncertain",
    created_at_ns: "1",
    updated_at_ns: "2",
  });
  expect(outgoing.state).toBe("uncertain");
  expect(outgoing.offeredKey).toBeNull();
  expect(outgoing.detail).toBeNull();

  expect(() =>
    parseOutgoingTrade({ ...outgoing, state: "invented" }),
  ).toThrow();
});

test("suggestions mark what is already in the directory", () => {
  const suggestion = parseSuggestion({
    contact_name: "Ada",
    principal: "aaaaa-aa",
    in_directory: false,
  });
  expect(suggestion.contactName).toBe("Ada");
  expect(suggestion.inDirectory).toBe(false);
});

test("backend error codes survive to the UI", () => {
  const error = new ChipswapError("slot_limit", "All ten design slots are in use.");
  expect(errorCode(error)).toBe("slot_limit");
  expect(errorCode(new Error("other"))).toBeNull();
});

test("display helpers stay readable", () => {
  expect(formatTimestamp("0")).not.toBe("unknown");
  expect(formatTimestamp("not a number")).toBe("unknown");
  expect(shortPrincipal("aaaaa-aa")).toBe("aaaaa-aa");
  expect(shortPrincipal("rrkah-fqaaa-aaaaa-aaaaq-cai")).toContain("…");
});
