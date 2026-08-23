// Anonymous queries to a peer's public routes: their catalog, and their
// directory page for the crawl.
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
import { unwrapBlobReturn } from "../ingress_wire.ts";
import {
  decodeCatalogReply,
  decodeDirectoryReply,
  MAX_MESSAGE_BYTES,
  type PeerDesign,
  type PeerDirectoryPage,
} from "../wire.ts";

const PHYSICAL_METHOD = "app_chipswap__chipswap_v1_query";
const ROUTE_CATALOG = "catalog";
const ROUTE_DIRECTORY = "directory";
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

/** The record `chipswap_directory_v1` declares: `{ offset : Nat; limit : Nat }`. */
const DirectoryRequest = IDL.Record({ offset: IDL.Nat, limit: IDL.Nat });

/**
 * One directory request. Unlike the catalog's empty record this carries a
 * position, so it is encoded per call rather than once.
 */
export function encodeDirectoryRequest(
  offset: number,
  limit: number,
): Uint8Array {
  return new Uint8Array(
    IDL.encode([DirectoryRequest], [{ offset, limit }]),
  );
}

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

/** The bytes a route answered with, or why we have none. */
type RouteReply = { payload: Uint8Array } | { error: string };

/**
 * One anonymous query to one of a peer's public routes.
 *
 * Everything both routes share lives here: the actor, the ingress envelope,
 * the error variant, and the second Candid layer around a Blob-returning
 * handler. What differs between them is the route id, the argument, and the
 * message inside — which is exactly what the callers below supply.
 */
async function queryRoute(
  designer: string,
  route: string,
  payload: Uint8Array,
): Promise<RouteReply> {
  try {
    const actor = Actor.createActor(idlFactory, {
      agent: await agent(),
      canisterId: designer,
    });
    const call = actor[PHYSICAL_METHOD] as (
      request: { method: string; payload: Uint8Array },
    ) => Promise<{ ok?: Uint8Array | number[]; err?: Record<string, null> }>;
    const reply = await call({ method: route, payload });

    if (reply.err !== undefined) {
      // A peer still on caller "canister" answers unauthorized. That is a
      // release they have not taken yet, not a designer who is gone.
      const [code] = Object.keys(reply.err);
      return { error: code ?? "rejected" };
    }
    if (reply.ok === undefined) return { error: "malformed_reply" };

    // Two Candid layers wrap the message. The actor took the outer one off;
    // the handler's Blob return is still encoded underneath it.
    const inner = unwrapBlobReturn(Uint8Array.from(reply.ok), MAX_MESSAGE_BYTES);
    if (inner === null) return { error: "malformed_envelope" };
    return { payload: inner };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unreachable" };
  }
}

export type CatalogFetch = { designs: PeerDesign[] } | { error: string };

export async function fetchCatalog(designer: string): Promise<CatalogFetch> {
  const reply = await queryRoute(designer, ROUTE_CATALOG, EMPTY_REQUEST);
  if ("error" in reply) return reply;
  const designs = decodeCatalogReply(reply.payload);
  // A message we cannot read is refused whole rather than partly kept.
  if (designs === null) return { error: "undecodable" };
  return { designs };
}

export type DirectoryFetch = { page: PeerDirectoryPage } | { error: string };

/**
 * One page of a peer's directory, for the crawl.
 *
 * Nothing read here is trusted beyond "somebody to ask next". The entries are
 * addresses, and an address a hostile peer invented costs us one query that
 * goes nowhere — which is why this route is worth reading anonymously and why
 * nothing it returns may be minted against.
 */
export async function fetchDirectoryPage(
  designer: string,
  offset: number,
  limit: number,
): Promise<DirectoryFetch> {
  const reply = await queryRoute(
    designer,
    ROUTE_DIRECTORY,
    encodeDirectoryRequest(offset, limit),
  );
  if ("error" in reply) return reply;
  const page = decodeDirectoryReply(reply.payload);
  if (page === null) return { error: "undecodable" };
  return { page };
}
