// The Candid frame around a peer's reply, read side, ported from
// backend/IngressWire.mo.
//
// A catalog does not arrive bare. The kernel's query dispatcher answers
// PublicIngressResultV1, and the #ok blob inside it is itself the Candid
// encoding of the handler's declared Blob return. The agent's IDL takes the
// outer layer off; this takes the inner one off, and only then does the CSW1
// message in src/wire.ts begin.
//
// Only the blob-return layer is ported. The backend also needs unwrapOk
// because it receives raw reply bytes from an inter-canister call, while the
// browser's actor has already decoded that layer by the time we are handed the
// payload.
//
// The frame is a constant byte prefix and one canonical LEB128 length, so it
// is checked by hand rather than by a Candid decoder: a peer is not trusted,
// and a reply that is wrong in any way is refused whole.

/** "DIDL", one type (vec nat8), one argument of that type. */
const BLOB_RETURN_PREFIX = [0x44, 0x49, 0x44, 0x4c, 1, 0x6d, 0x7b, 1, 0] as const;

/** A route is capped well below 2^21 bytes, so four length bytes is generous. */
const MAX_LENGTH_BYTES = 4;

/**
 * The payload of a Blob-returning handler, or null if these bytes are not
 * exactly one such frame. There is no partial read and no repair.
 */
export function unwrapBlobReturn(
  reply: Uint8Array,
  maximum: number,
): Uint8Array | null {
  const prefix = BLOB_RETURN_PREFIX;
  if (reply.length < prefix.length + 1) return null;
  if (reply.length > prefix.length + MAX_LENGTH_BYTES + maximum) return null;
  for (let index = 0; index < prefix.length; index += 1) {
    if (reply[index] !== prefix[index]) return null;
  }

  let index = prefix.length;
  let length = 0;
  let multiplier = 1;
  let count = 0;
  for (;;) {
    if (index >= reply.length || count >= MAX_LENGTH_BYTES) return null;
    const byte = reply[index] ?? 0;
    const low = byte % 128;
    // Checked before the addition: a length that cannot fit is refused rather
    // than wrapped into one that can.
    if (length > maximum) return null;
    if (low > Math.floor((maximum - length) / multiplier)) return null;
    length += low * multiplier;
    index += 1;
    count += 1;
    if (byte < 128) {
      // Reject non-canonical forms such as 0x80 0x00: one reply, one encoding.
      if (count > 1 && low === 0) return null;
      break;
    }
    multiplier *= 128;
  }
  if (length > maximum || index + length !== reply.length) return null;
  return reply.subarray(index, index + length);
}
