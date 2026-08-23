// One anonymous query to a peer's catalog route.
//
// Three formats are nested here. The outer two are Candid: the ingress
// envelope the peer's dispatcher decodes, and the result variant it answers
// with. The innermost is not — the ok payload is the hand-rolled CSW1 message
// that src/wire.ts reads. Only the middle layer is a protocol shared with the
// kernel; the inner one is Chipswap's own.
//
// The identity is anonymous because it has to be: a tile never holds the
// owner's credentials, and the only owner-identity path prompts once per call.
// Query signature verification stays on, so a boundary node cannot forge a
// reply undetected. A peer's own canister can still answer a browser
// differently than it answers a canister, which is why nothing read here is
// trusted enough to mint against — chipswap_trade_propose re-asks the peer
// through the backend before anything is spent.

import { Actor, HttpAgent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { icHost } from "neutron-tools/src/runtime.js";
import { decodeCatalogReply, type PeerDesign } from "../wire.ts";

const PHYSICAL_METHOD = "app_chipswap__chipswap_v1_query";
const ROUTE_ID = "catalog";
/**
 * The gateway every other Neutron surface queries through, and the one the
 * background's connect-src names. Spelling it here instead of importing it
 * once cost a release: `https://icp0.io` is a different origin, and the
 * policy refused it.
 */
export const MAINNET_GATEWAY = icHost();

const IngressRequest = IDL.Record({
  method: IDL.Text,
  payload: IDL.Vec(IDL.Nat8),
});

const IngressResult = IDL.Variant({
  ok: IDL.Vec(IDL.Nat8),
  err: IDL.Variant({
    bad_request: IDL.Null,
    not_found: IDL.Null,
    too_large: IDL.Null,
    unauthorized: IDL.Null,
    rate_limited: IDL.Null,
    busy: IDL.Null,
    low_cycles: IDL.Null,
    revoked: IDL.Null,
    revoked_after_dispatch: IDL.Null,
    handler_failed: IDL.Null,
  }),
});

const idlFactory = () =>
  IDL.Service({
    [PHYSICAL_METHOD]: IDL.Func([IngressRequest], [IngressResult], ["query"]),
  });

/** The empty record the catalog route takes, encoded once. */
const EMPTY_REQUEST = new Uint8Array(IDL.encode([IDL.Record({})], [{}]));

function isLocalHost(host: string): boolean {
  return /(^|\.)localhost(:|$)|^127\.0\.0\.1(:|$)/.test(host);
}

/** The gateway this page was itself served from, or mainnet. */
function gatewayOrigin(): string {
  const location = globalThis.location;
  if (location === undefined) return MAINNET_GATEWAY;
  return isLocalHost(location.host)
    ? `${location.protocol}//${location.host}`
    : MAINNET_GATEWAY;
}

let agentPromise: Promise<HttpAgent> | null = null;

function agent(): Promise<HttpAgent> {
  if (agentPromise !== null) return agentPromise;
  agentPromise = (async () => {
    const host = gatewayOrigin();
    const created = await HttpAgent.create({ host });
    // A local replica's root key is not the compiled mainnet one.
    if (host !== MAINNET_GATEWAY) await created.fetchRootKey();
    return created;
  })();
  return agentPromise;
}

export type CatalogFetch = { designs: PeerDesign[] } | { error: string };

export async function fetchCatalog(designer: string): Promise<CatalogFetch> {
  try {
    const actor = Actor.createActor(idlFactory, {
      agent: await agent(),
      canisterId: designer,
    });
    const call = actor[PHYSICAL_METHOD] as (
      request: { method: string; payload: Uint8Array },
    ) => Promise<{ ok?: Uint8Array | number[]; err?: Record<string, null> }>;
    const reply = await call({ method: ROUTE_ID, payload: EMPTY_REQUEST });

    if (reply.err !== undefined) {
      // A peer still on caller "canister" answers unauthorized. That is a
      // release they have not taken yet, not a designer who is gone.
      const [code] = Object.keys(reply.err);
      return { error: code ?? "rejected" };
    }
    if (reply.ok === undefined) return { error: "malformed_reply" };

    const designs = decodeCatalogReply(Uint8Array.from(reply.ok));
    // A message we cannot read is refused whole rather than partly kept.
    if (designs === null) return { error: "undecodable" };
    return { designs };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unreachable" };
  }
}
