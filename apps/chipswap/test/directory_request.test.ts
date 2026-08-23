import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { encodeDirectoryRequest } from "../src/resident/agent.ts";

// The one part of a peer query that is checkable without a network: the
// argument. `chipswap_directory_v1` declares
// `PeerDirectoryRequest = { offset : Nat; limit : Nat }`, and the kernel
// decodes it before app code runs — so an argument encoded with the wrong
// Candid type is not a wrong answer, it is `bad_request` from every peer at
// once, which reads exactly like a network nobody has upgraded.

/** What Motoko's `{ offset : Nat; limit : Nat }` compiles to. */
const PeerDirectoryRequest = IDL.Record({
  offset: IDL.Nat,
  limit: IDL.Nat,
});

test("a directory request decodes as the record the peer's handler declares", () => {
  const [decoded] = IDL.decode(
    [PeerDirectoryRequest],
    encodeDirectoryRequest(128, 128).buffer as ArrayBuffer,
  );
  expect(decoded).toEqual({ offset: 128n, limit: 128n });
});

test("the first page is offset zero", () => {
  const [decoded] = IDL.decode(
    [PeerDirectoryRequest],
    encodeDirectoryRequest(0, 128).buffer as ArrayBuffer,
  );
  expect(decoded).toEqual({ offset: 0n, limit: 128n });
});
