import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryPanel } from "../src/views/trades.tsx";
import type { TradeHistoryEntry } from "../src/api.ts";

const entry = (overrides: Partial<TradeHistoryEntry> = {}): TradeHistoryEntry => ({
  entryId: 1,
  direction: "outgoing",
  peer: "aaaaa-aa",
  requestId: "ab12",
  wantDesignId: 1,
  ours: { title: "Bluebird", designer: "aaaaa-aa", designId: 1, serial: 2 },
  theirs: { title: "Ember", designer: "aaaaa-aa", designId: 3, serial: 9 },
  outcome: "traded",
  detail: null,
  startedAtNs: "100",
  settledAtNs: "200",
  contactName: null,
  ...overrides,
});

const markup = (entries: TradeHistoryEntry[], total = entries.length) =>
  renderToStaticMarkup(
    <HistoryPanel
      busy={null}
      entries={entries}
      onAskAgain={() => {}}
      onClear={() => {}}
      onForget={() => {}}
      onShowMore={() => {}}
      total={total}
    />,
  );

test("a completed trade names both chips", () => {
  const html = markup([entry()]);
  expect(html).toContain("Bluebird");
  expect(html).toContain("Ember");
  expect(html).toContain("Traded");
});

// The row this panel exists for. Nothing of ours moved, and the chip we turned
// down is still the whole content of the record.
test("an offer we declined names the chip we turned down", () => {
  const html = markup([
    entry({ direction: "incoming", ours: null, outcome: "declined_by_owner" }),
  ]);
  expect(html).toContain("Ember");
  expect(html).toContain("You declined");
});

test("a peer's reason is shown beside their refusal", () => {
  const html = markup([
    entry({ theirs: null, outcome: "declined_by_peer", detail: "min_colors" }),
  ]);
  expect(html).toContain("They declined");
  expect(html).toContain("min_colors");
});

// Asking again is offered only where there is still something to ask about.
test("only an unresolved trade offers to ask again", () => {
  expect(markup([entry()])).not.toContain("Ask again");
  expect(markup([entry({ outcome: "unresolved", theirs: null })])).toContain(
    "Ask again",
  );
});

// A bulk clear that silently took the unresolved rows would strand the chips
// they name, so the button says what it actually does.
test("the bulk action says it clears only what is settled", () => {
  expect(markup([entry()])).toContain("Forget settled");
});

test("an empty ledger explains what will appear in it", () => {
  const html = markup([]);
  expect(html).toContain("No finished trades yet");
  expect(html).not.toContain("Forget settled");
});

test("more rows than one page shows a way to reach them", () => {
  expect(markup([entry()], 40)).toContain("Show more");
  expect(markup([entry()], 1)).not.toContain("Show more");
});
