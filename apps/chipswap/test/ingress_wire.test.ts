import { expect, test } from "bun:test";
import fixtures from "./fixtures/catalog_wire.json" with { type: "json" };
import { unwrapBlobReturn } from "../src/ingress_wire.ts";
import { decodeCatalogReply, MAX_MESSAGE_BYTES } from "../src/wire.ts";

// A peer's catalog arrives inside two Candid layers, not one. The agent's IDL
// takes the outer PublicIngressResultV1 off; what is left is still the Candid
// encoding of the handler's Blob return, and the catalog message only starts
// after that. Reading just the first layer is what shipped: every reply came
// back well-formed and every one was thrown away.
//
// These are the same bytes test/wire_fixtures.test.mo reads, built by the
// Motoko encoder that produces the real frames.

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../gu)?.map((pair) => parseInt(pair, 16)) ?? []);
}

const envelope = fixtures.envelope as Record<string, string>;
const envelopeInvalid = fixtures.envelope_invalid as Record<string, string>;

test.each(Object.keys(envelope))("%s unwraps to a readable catalog", (name) => {
  const inner = unwrapBlobReturn(bytes(envelope[name] ?? ""), MAX_MESSAGE_BYTES);
  expect(inner).not.toBeNull();
  // Unwrapping is only right if what falls out is the message itself.
  expect(decodeCatalogReply(inner as Uint8Array)).not.toBeNull();
});

test.each(Object.keys(envelopeInvalid))("%s is refused", (name) => {
  expect(unwrapBlobReturn(bytes(envelopeInvalid[name] ?? ""), MAX_MESSAGE_BYTES)).toBeNull();
});

test("the payload that falls out is the one that went in", () => {
  const inner = unwrapBlobReturn(bytes(envelope.one_design ?? ""), MAX_MESSAGE_BYTES);
  expect(inner).not.toBeNull();
  // The valid catalog fixtures are the payloads these frames were built from,
  // so the frame carrying open_single must yield exactly those bytes.
  expect(Array.from(inner as Uint8Array)).toEqual(
    Array.from(bytes(fixtures.valid.open_single)),
  );
});

test("an empty catalog still has a frame around it", () => {
  const inner = unwrapBlobReturn(bytes(envelope.empty_payload ?? ""), MAX_MESSAGE_BYTES);
  expect(decodeCatalogReply(inner as Uint8Array)).toEqual([]);
});

test("three designs survive the round trip", () => {
  const inner = unwrapBlobReturn(bytes(envelope.three ?? ""), MAX_MESSAGE_BYTES);
  expect(decodeCatalogReply(inner as Uint8Array)).toHaveLength(3);
});

test("a payload larger than the cap is refused rather than truncated", () => {
  const frame = bytes(envelope.three ?? "");
  expect(unwrapBlobReturn(frame, 16)).toBeNull();
});
