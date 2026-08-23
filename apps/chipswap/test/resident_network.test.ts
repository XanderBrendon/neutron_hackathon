import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { icHost } from "neutron-tools/src/runtime.js";
import { MAINNET_GATEWAY } from "../src/resident/agent.ts";

// The background declares where it may connect and then connects somewhere.
// Nothing in the type system ties those two together, so a policy that reads
// as though it covers the gateway can still refuse every request the agent
// makes. These tests are that missing tie: they resolve the document's
// connect-src the way a browser does and point it at the URL the agent will
// actually open.

const PEER = "3wvx3-yaaaa-aaaay-aacuq-cai";

async function connectSrc(): Promise<string[]> {
  const html = await readFile(
    new URL("../public/service.html", import.meta.url),
    "utf8",
  );
  const policy = /content="([^"]*)"/u.exec(html)?.[1] ?? "";
  const directive = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src"));
  if (directive === undefined) throw new Error("no connect-src directive");
  return directive.split(/\s+/u).slice(1);
}

/**
 * CSP 3 host-source matching, in the one detail that matters here: a source
 * beginning `*.` matches subdomains and never the bare domain, because the
 * remainder must be preceded by a dot in the host being tested.
 */
function matches(source: string, target: URL, documentOrigin: string): boolean {
  if (source === "'self'") return target.origin === documentOrigin;
  if (!source.includes("://")) return false;
  const [scheme = "", rest = ""] = source.split("://", 2);
  if (`${scheme}:` !== target.protocol) return false;
  const colon = rest.lastIndexOf(":");
  const host = colon === -1 ? rest : rest.slice(0, colon);
  const port = colon === -1 ? "" : rest.slice(colon + 1);
  if (host.startsWith("*.")) {
    if (!target.hostname.endsWith(`.${host.slice(2)}`)) return false;
  } else if (target.hostname !== host) return false;
  if (port === "" || port === "*") return true;
  return target.port === port;
}

function permits(sources: string[], url: string, documentOrigin: string): boolean {
  const target = new URL(url);
  return sources.some((source) => matches(source, target, documentOrigin));
}

test("the background's gateway is the one the rest of the repo uses", () => {
  // A second spelling of the gateway is a second thing to keep right. icHost
  // is where that decision already lives.
  expect(MAINNET_GATEWAY).toBe(icHost());
});

test("the background may connect to the gateway it queries peers through", async () => {
  const sources = await connectSrc();
  const query = `${MAINNET_GATEWAY}/api/v2/canister/${PEER}/query`;
  // The frame is served from its own dedicated origin, which is not the
  // gateway, so 'self' cannot be what carries this.
  const frame = `https://chipswap--${PEER}.icp0.io`;
  expect(permits(sources, query, frame)).toBe(true);
});

test("a local frame reaches its own gateway origin", async () => {
  const sources = await connectSrc();
  const frame = `http://chipswap--${PEER}.localhost:8000`;
  expect(permits(sources, `${frame}/api/v2/canister/${PEER}/query`, frame)).toBe(
    true,
  );
  // PocketIC may serve the background from an opaque origin, where 'self'
  // matches nothing and only the explicit localhost sources are left.
  expect(permits(sources, `${frame}/api/v2/status`, "null")).toBe(true);
});

test("the policy grants nothing beyond the gateway and the frame", async () => {
  const sources = await connectSrc();
  const frame = `https://chipswap--${PEER}.icp0.io`;
  for (const denied of [
    `https://${PEER}.icp0.io/api/v2/canister/${PEER}/query`,
    "https://icp0.io/api/v2/status",
    "https://example.com/",
    "https://icp-api.io.example.com/",
  ]) {
    expect(permits(sources, denied, frame)).toBe(false);
  }
});

test("a wildcard host source never covers the bare domain", () => {
  // This is the rule the first release got wrong: `*.icp0.io` reads as though
  // it includes icp0.io and does not. Asserting it here keeps the matcher
  // above honest rather than accidentally permissive.
  const target = new URL("https://icp0.io/api/v2/status");
  expect(matches("https://*.icp0.io", target, "https://x.icp0.io")).toBe(false);
  expect(
    matches("https://*.icp0.io", new URL("https://a.icp0.io/x"), "https://x.icp0.io"),
  ).toBe(true);
});
