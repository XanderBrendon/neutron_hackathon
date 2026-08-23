import { expect, test } from "bun:test";
import {
  buildMarketPage,
  ownedKey,
  type MarketInput,
} from "../src/market_page.ts";
import { defaultFilter } from "../src/market_filter.ts";
import { PIXEL_COUNT } from "../src/chip.ts";
import type { PeerDesign } from "../src/wire.ts";
import type { Chip, Design } from "../src/api.ts";

// The join the backend used to do over a stored cache, now done in the tile
// over the browser's copy. `total` counts the filtered set rather than the
// cache, because a page control over a number that does not match what was
// filtered is a page control that lies about how much is left.

const ALICE = "aaaaa-aa";
const BOB = "bbbbb-bb";

/** `count` distinct colours across the chip, so `measure` sees them. */
function art(colors: number) {
  const palette = Array.from({ length: colors }, (_, i) =>
    `#${i.toString(16).padStart(2, "0")}0000`,
  );
  const pixels = Array.from({ length: PIXEL_COUNT }, (_, i) =>
    (i % colors).toString(16).padStart(2, "0"),
  ).join("");
  return { shapeId: "circle31", palette, pixels };
}

function design(
  designId: number,
  title: string,
  extra: Partial<PeerDesign> = {},
): PeerDesign {
  return {
    designId,
    title,
    art: art(2),
    requirements: {
      approval: false,
      minColors: null,
      maxCoverage: null,
      nsfw: "any",
    },
    nsfw: false,
    designRevision: "1",
    publishedAtNs: "1000",
    ...extra,
  };
}

function input(overrides: Partial<MarketInput> = {}): MarketInput {
  return {
    catalogs: [
      {
        designer: ALICE,
        designs: [design(1, "Alpha")],
        fetchedAtMs: 500,
        lastError: null,
      },
      {
        designer: BOB,
        designs: [design(2, "Beta")],
        fetchedAtMs: 900,
        lastError: null,
      },
    ],
    directory: [
      { canister: ALICE, ignored: false, contactName: "Alice" },
      { canister: BOB, ignored: false, contactName: null },
    ],
    ownedKeys: new Set<string>(),
    holdings: [],
    ownDesigns: [],
    ...overrides,
  };
}

test("every followed designer's designs appear once, newest fetch first", () => {
  const page = buildMarketPage(input(), defaultFilter(), 0, 24);
  expect(page.total).toBe(2);
  expect(page.rows.map((row) => row.title)).toEqual(["Beta", "Alpha"]);
});

// Ignoring is the only thing that withholds a designer from the market. A
// designer who did not answer the last fetch is not withheld: their chips stay
// on screen from the last time they did, and the Market names them above the
// grid so the owner can decide whether to withhold them.
test("an ignored designer contributes nothing, and nobody else is withheld", () => {
  const page = buildMarketPage(
    input({
      directory: [
        { canister: ALICE, ignored: true, contactName: null },
        { canister: BOB, ignored: false, contactName: null },
      ],
    }),
    defaultFilter(),
    0,
    24,
  );
  expect(page.total).toBe(1);
  expect(page.rows[0]!.designer).toBe(BOB);
});

test("a designer whose last fetch failed keeps the chips they last gave us", () => {
  const page = buildMarketPage(
    input({
      catalogs: [
        {
          designer: ALICE,
          designs: [design(1, "Alpha")],
          fetchedAtMs: 500,
          lastError: "not_found",
        },
      ],
      directory: [{ canister: ALICE, ignored: false, contactName: null }],
    }),
    defaultFilter(),
    0,
    24,
  );
  expect(page.rows.map((row) => row.title)).toEqual(["Alpha"]);
});

test("a cached designer no longer in the directory contributes nothing", () => {
  // The background evicts on removal, but a market that trusted the cache
  // alone would show a removed designer until that eviction landed.
  const page = buildMarketPage(input({ directory: [] }), defaultFilter(), 0, 24);
  expect(page.total).toBe(0);
});

test("the contact name rides along from the directory", () => {
  const page = buildMarketPage(input(), defaultFilter(), 0, 24);
  expect(page.rows.find((row) => row.title === "Alpha")?.contactName).toBe("Alice");
  expect(page.rows.find((row) => row.title === "Beta")?.contactName).toBeNull();
});

test("owned chips are hidden by default and flagged when shown", () => {
  const ownedKeys = new Set([ownedKey(ALICE, 1)]);
  expect(buildMarketPage(input({ ownedKeys }), defaultFilter(), 0, 24).total).toBe(1);

  const shown = buildMarketPage(
    input({ ownedKeys }),
    { ...defaultFilter(), hideOwned: false },
    0,
    24,
  );
  expect(shown.total).toBe(2);
  expect(shown.rows.find((row) => row.title === "Alpha")?.owned).toBe(true);
  expect(shown.rows.find((row) => row.title === "Beta")?.owned).toBe(false);
});

test("tagged designs are withheld and tallied rather than dropped silently", () => {
  const tagged = input({
    catalogs: [
      {
        designer: ALICE,
        designs: [design(1, "Alpha", { nsfw: true }), design(3, "Gamma")],
        fetchedAtMs: 500,
        lastError: null,
      },
    ],
    directory: [
      { canister: ALICE, ignored: false, contactName: null },
    ],
  });

  const hidden = buildMarketPage(tagged, defaultFilter(), 0, 24);
  expect(hidden.total).toBe(1);
  expect(hidden.nsfwHidden).toBe(1);

  const shown = buildMarketPage(tagged, { ...defaultFilter(), showNsfw: true }, 0, 24);
  expect(shown.total).toBe(2);
  expect(shown.nsfwHidden).toBe(0);
});

// The tally counts only rows that survived every other filter, or it would
// report chips the reader had already excluded for some other reason.
test("the tag tally counts only what the other filters left", () => {
  const tagged = input({
    catalogs: [
      {
        designer: ALICE,
        designs: [design(1, "Alpha", { nsfw: true })],
        fetchedAtMs: 500,
        lastError: null,
      },
      {
        designer: BOB,
        designs: [design(2, "Beta", { nsfw: true })],
        fetchedAtMs: 900,
        lastError: null,
      },
    ],
  });
  const page = buildMarketPage(tagged, { ...defaultFilter(), designer: ALICE }, 0, 24);
  expect(page.total).toBe(0);
  expect(page.nsfwHidden).toBe(1);
});

test("search matches title, designer, and contact name, case-insensitively", () => {
  const byTitle = buildMarketPage(input(), { ...defaultFilter(), search: "alph" }, 0, 24);
  expect(byTitle.rows.map((row) => row.title)).toEqual(["Alpha"]);

  const byContact = buildMarketPage(
    input(),
    { ...defaultFilter(), search: "ALICE" },
    0,
    24,
  );
  expect(byContact.rows.map((row) => row.title)).toEqual(["Alpha"]);

  const byDesigner = buildMarketPage(
    input(),
    { ...defaultFilter(), search: BOB },
    0,
    24,
  );
  expect(byDesigner.rows.map((row) => row.title)).toEqual(["Beta"]);
});

test("a search of nothing but spaces narrows nothing", () => {
  const page = buildMarketPage(input(), { ...defaultFilter(), search: "   " }, 0, 24);
  expect(page.total).toBe(2);
});

test("the designer filter narrows to one principal", () => {
  const page = buildMarketPage(input(), { ...defaultFilter(), designer: BOB }, 0, 24);
  expect(page.rows.map((row) => row.title)).toEqual(["Beta"]);
});

test("sorting is independent of fetch order and stable on ties", () => {
  expect(
    buildMarketPage(input(), { ...defaultFilter(), sort: "title" }, 0, 24).rows.map(
      (row) => row.title,
    ),
  ).toEqual(["Alpha", "Beta"]);
  expect(
    buildMarketPage(input(), { ...defaultFilter(), sort: "oldest" }, 0, 24).rows.map(
      (row) => row.title,
    ),
  ).toEqual(["Alpha", "Beta"]);
  expect(
    buildMarketPage(input(), { ...defaultFilter(), sort: "designer" }, 0, 24).rows.map(
      (row) => row.title,
    ),
  ).toEqual(["Alpha", "Beta"]);
});

test("rows from one designer tie-break on design id, not fetch time", () => {
  const many = input({
    catalogs: [
      {
        designer: ALICE,
        designs: [design(3, "Same"), design(1, "Same"), design(2, "Same")],
        fetchedAtMs: 500,
        lastError: null,
      },
    ],
    directory: [
      { canister: ALICE, ignored: false, contactName: null },
    ],
  });
  expect(
    buildMarketPage(many, defaultFilter(), 0, 24).rows.map((row) => row.designId),
  ).toEqual([1, 2, 3]);
});

// --- Requirement facets -----------------------------------------------------

const PICKY = {
  approval: false,
  minColors: 6,
  maxCoverage: null,
  nsfw: "any",
} as const;

function facetInput(): MarketInput {
  return input({
    catalogs: [
      {
        designer: ALICE,
        designs: [
          design(1, "Open"),
          design(2, "Approves", {
            requirements: {
              approval: true,
              minColors: null,
              maxCoverage: null,
              nsfw: "any",
            },
          }),
          design(3, "Picky", { requirements: { ...PICKY } }),
          design(4, "NoTags", {
            requirements: {
              approval: false,
              minColors: null,
              maxCoverage: null,
              nsfw: "disallowed",
            },
          }),
        ],
        fetchedAtMs: 500,
        lastError: null,
      },
    ],
    directory: [
      { canister: ALICE, ignored: false, contactName: null },
    ],
  });
}

function titlesFor(facets: string[], extra: Partial<MarketInput> = {}): string[] {
  return buildMarketPage(
    { ...facetInput(), ...extra },
    { ...defaultFilter(), sort: "title", requirements: facets as never },
    0,
    24,
  ).rows.map((row) => row.title);
}

test("each requirement facet selects the designs that carry it", () => {
  expect(titlesFor(["open"])).toEqual(["Open"]);
  expect(titlesFor(["approval"])).toEqual(["Approves"]);
  expect(titlesFor(["min_colors"])).toEqual(["Picky"]);
  expect(titlesFor(["tag_rule"])).toEqual(["NoTags"]);
});

test("facets widen each other and repeating one adds nothing", () => {
  expect(titlesFor(["approval", "min_colors"])).toEqual(["Approves", "Picky"]);
  expect(titlesFor(["approval", "approval"])).toEqual(["Approves"]);
});

test("no facet ticked is no constraint rather than a facet matching nothing", () => {
  expect(titlesFor([])).toEqual(["Approves", "NoTags", "Open", "Picky"]);
});

// "Trades I can make" is answered by measuring what we could offer, which is
// the one facet that cannot be read off the design alone.
test("nothing to offer means nothing is tradeable", () => {
  expect(titlesFor(["tradeable"])).toEqual([]);
});

test("a two-colour chip clears the designs that ask nothing of the artwork", () => {
  const holding: Chip = {
    key: "k",
    designer: BOB,
    designId: 9,
    serial: 1,
    title: "Mine",
    art: art(2),
    nsfw: false,
    designRevision: 1,
    mintedAtNs: "1",
    acquiredAtNs: "1",
    state: "held",
    peer: null,
    requestId: null,
    contactName: null,
    origin: "held",
    mintedCount: 1,
  };
  // Open and Approves ask nothing of the artwork, and NoTags refuses a tagged
  // offer, which this chip is not. Picky wants six colours and this has two.
  // Approval is not consulted: it decides what happens to an offer that
  // already qualifies, not whether it qualifies.
  expect(titlesFor(["tradeable"], { holdings: [holding] })).toEqual([
    "Approves",
    "NoTags",
    "Open",
  ]);

  // Six colours clears the minimum, so Picky joins them.
  const richer: Chip = { ...holding, art: art(6) };
  expect(titlesFor(["tradeable"], { holdings: [richer] })).toEqual([
    "Approves",
    "NoTags",
    "Open",
    "Picky",
  ]);
});

test("a published design of our own counts as an offer, a draft does not", () => {
  const published: Design = {
    designId: 1,
    title: "Mine",
    art: art(6),
    state: "published",
    requirements: {
      approval: false,
      minColors: null,
      maxCoverage: null,
      nsfw: "any",
    },
    nsfw: false,
    revision: 1,
    createdAtNs: "1",
    publishedAtNs: "2",
    mintedCount: 0,
  };
  expect(titlesFor(["tradeable"], { ownDesigns: [published] })).toEqual([
    "Approves",
    "NoTags",
    "Open",
    "Picky",
  ]);

  // A draft cannot be offered, so it must not make a design look tradeable.
  const draft: Design = { ...published, state: "draft", publishedAtNs: null };
  expect(titlesFor(["tradeable"], { ownDesigns: [draft] })).toEqual([]);
});

// --- Paging -----------------------------------------------------------------

test("total counts the filtered set, so paging stays honest", () => {
  const many = input({
    catalogs: [
      {
        designer: ALICE,
        designs: Array.from({ length: 5 }, (_, i) => design(i + 1, `Chip ${i + 1}`)),
        fetchedAtMs: 500,
        lastError: null,
      },
    ],
    directory: [
      { canister: ALICE, ignored: false, contactName: null },
    ],
  });
  const page = buildMarketPage(many, { ...defaultFilter(), sort: "title" }, 2, 2);
  expect(page.total).toBe(5);
  expect(page.rows.map((row) => row.title)).toEqual(["Chip 3", "Chip 4"]);
});

test("an offset past the end yields no rows but keeps the true total", () => {
  const page = buildMarketPage(input(), defaultFilter(), 99, 24);
  expect(page.rows).toEqual([]);
  expect(page.total).toBe(2);
});

test("an empty cache is an empty market, not an error", () => {
  const page = buildMarketPage(input({ catalogs: [] }), defaultFilter(), 0, 24);
  expect(page).toEqual({ rows: [], total: 0, nsfwHidden: 0 });
});
