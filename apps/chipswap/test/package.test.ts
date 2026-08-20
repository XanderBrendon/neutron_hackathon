import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  generateAppMethodSchemaArtifact,
  validateAppMethodArgs,
} from "neutron-scripts/src/method_schema.js";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);
const jsUrl = new URL("../dist/web/main.js", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

// The shared manifest type keeps most sections optional; Chipswap declares them
// all, so the tests read them through a checked accessor rather than casts.
function funcMap(manifest: NeutronManifest): Record<string, { type: string; async: unknown; arg?: string[] }> {
  const map = manifest.func;
  if (!map) throw new Error("The manifest declares no methods");
  return map as Record<string, { type: string; async: unknown; arg?: string[] }>;
}

function routes(manifest: NeutronManifest) {
  const ingress = manifest.capabilities?.public_ingress;
  if (!ingress) throw new Error("The manifest declares no public ingress");
  return ingress.routes;
}

async function readBackend(): Promise<string> {
  return readFile(backendUrl, "utf8");
}

test("chipswap manifest validates and declares its identity and tile", async () => {
  const manifest = await readManifest();

  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(manifest).toMatchObject({
    format: 3,
    id: "chipswap",
    name: "Chipswap",
    version: 104,
    update_source: "233tv-xiaaa-aaaay-aacta-cai",
    src: "main.mo",
    tiles: [
      {
        id: "chipswap",
        title: "Chipswap",
        path: "index.html",
        icon: "static/icon.svg",
      },
    ],
    memory: {
      chipswap: {
        version: 1,
        schemas: { 1: { src: "memory/chipswap/v1.mo" } },
        migrations: [],
      },
    },
  });
  expect(manifest).not.toHaveProperty("init_arg");
});

test("chipswap declares the five paid chipswap_v1 routes", async () => {
  const manifest = await readManifest();

  expect(manifest.capabilities?.public_ingress).toMatchObject({
    api: 1,
    routes: [
      {
        protocol: "chipswap_v1",
        id: "catalog",
        handler: "chipswap_catalog_v1",
        mode: "update",
        caller: "canister",
        max_request_bytes: 1024,
        max_response_bytes: 65536,
        max_calls_per_hour: 240,
        max_calls_per_caller_per_hour: 60,
        required_cycles: 300000000,
      },
      {
        protocol: "chipswap_v1",
        id: "trade",
        handler: "chipswap_trade_v1",
        mode: "update",
        caller: "canister",
        max_request_bytes: 16384,
        max_response_bytes: 16384,
        required_cycles: 600000000,
      },
      {
        protocol: "chipswap_v1",
        id: "deliver",
        handler: "chipswap_deliver_v1",
        mode: "update",
        caller: "canister",
        required_cycles: 600000000,
      },
      {
        protocol: "chipswap_v1",
        id: "status",
        handler: "chipswap_status_v1",
        mode: "update",
        caller: "canister",
        required_cycles: 200000000,
      },
      {
        protocol: "chipswap_v1",
        id: "announce",
        handler: "chipswap_announce_v1",
        mode: "update",
        caller: "canister",
        required_cycles: 200000000,
      },
    ],
  });

  // Every route handler takes the kernel-supplied caller and nothing else.
  for (const route of routes(manifest)) {
    expect(funcMap(manifest)[route.handler]).toEqual({
      type: "update",
      async: false,
      arg: ["caller"],
    });
  }
});

test("outbound trading is scoped to the chipswap dispatcher alone", async () => {
  const manifest = await readManifest();

  expect(manifest.backend).toEqual({ capabilities: { backend_calls: { api: 1 } } });
  expect(manifest.capabilities?.backend_calls).toMatchObject({
    api: 1,
    reservation_scopes: ["method"],
    install_reservations: [
      { kind: "method", method: "app_chipswap__chipswap_v1_update" },
    ],
    max_concurrency: 8,
    max_cycles_per_call: 600000000,
  });

  // The per-call ceiling must cover the most expensive route floor.
  const floors = routes(manifest).map((route) => route.required_cycles ?? 0);
  expect(manifest.capabilities?.backend_calls?.max_cycles_per_call).toBeGreaterThanOrEqual(
    Math.max(...floors),
  );
});

test("chipswap depends on Contacts for designer discovery", async () => {
  const manifest = await readManifest();

  expect(manifest.dependencies).toEqual({
    contacts: {
      app: "contacts",
      min_version: 101,
      functions: ["contacts_neutron_lookup_v2", "contacts_neutron_search_v2"],
    },
  });
});

test("every owner-facing method is preapproved and no route handler is", async () => {
  const manifest = await readManifest();
  const preapproved = manifest.capabilities?.preapproved_self_calls?.methods ?? [];
  const handlers = new Set(routes(manifest).map((route) => route.handler));

  expect(preapproved.length).toBeGreaterThan(0);
  expect(new Set(preapproved).size).toBe(preapproved.length);

  for (const method of preapproved) {
    const entry = funcMap(manifest)[method];
    expect(entry).toBeDefined();
    expect(["query", "update"]).toContain(entry?.type ?? "missing");
    expect(handlers.has(method)).toBe(false);
  }

  // Nothing owner-facing is left out of the preapproved list by accident.
  for (const [name, entry] of Object.entries(funcMap(manifest))) {
    if (handlers.has(name)) continue;
    expect(preapproved).toContain(name);
    expect(entry).not.toHaveProperty("allow");
  }
});

test("the backend defines every declared method", async () => {
  const manifest = await readManifest();
  const backend = await readBackend();

  for (const name of Object.keys(funcMap(manifest))) {
    expect(backend).toContain(name);
  }
  // Ordinary apps may not open direct public access.
  expect(backend).not.toContain('allow = "unauthorized"');
});

test("chipswap emits usable method schemas", async () => {
  const manifest = await readManifest();
  const backend = await readBackend();
  const artifact = generateAppMethodSchemaArtifact(manifest, backend);

  expect(Object.keys(artifact.methods).length).toBe(
    Object.keys(funcMap(manifest)).length,
  );
  expect(artifact.methods.chipswap_draft_create).toMatchObject({ type: "update" });
  expect(artifact.methods.chipswap_status).toMatchObject({ type: "query" });

  expect(
    validateAppMethodArgs(artifact, "chipswap_draft_create", [{ title: "Sunrise" }]).valid,
  ).toBe(true);
  expect(validateAppMethodArgs(artifact, "chipswap_draft_create", []).valid).toBe(false);
  expect(
    validateAppMethodArgs(artifact, "chipswap_design", [{ design_id: "1" }]).valid,
  ).toBe(true);
});

test("chipswap bundles the shared design system stylesheet", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const css = await readFile(cssUrl, "utf8");

  expect(html).toContain("./main.css");
  expect(css).toContain(".nt-app");
  expect(css).toContain(".nt-button");
  expect(css).toContain("--nt-bg-panel");
  expect(css).not.toMatch(/gradient\s*\(/i);
  expect(css).not.toMatch(/border-radius\s*:\s*(?:[6-9]|\d{2,})px/i);
});

test("the tile bundle loads nothing from an external host", async () => {
  const js = await readFile(jsUrl, "utf8");

  expect(js.length).toBeGreaterThan(1000);
  // A concrete external hostname would mean the tile depends on a network it
  // cannot reach from a credentialless frame. Schema pattern strings such as
  // "^https://[^/?#@]+/" are not hostnames and stay allowed.
  expect(js).not.toMatch(/https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i);
  expect(js).toContain("#react-error-");
});
