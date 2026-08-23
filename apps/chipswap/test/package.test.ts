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
    version: 116,
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
    // Every released schema stays exactly as released, so each persistent change
    // adds a version beside its predecessors. The edges are linear and complete,
    // which is what lets a canister still on v1 reach v5 in one upgrade.
    //
    // V5 is the case the rule exists for that is easiest to get wrong: it
    // changes no type at all, only what a clean install starts with, and a
    // clean-install default is exactly as immutable at a released version as a
    // field is.
    memory: {
      chipswap: {
        version: 6,
        schemas: {
          1: { src: "memory/chipswap/v1.mo" },
          2: { src: "memory/chipswap/v2.mo" },
          3: { src: "memory/chipswap/v3.mo" },
          4: { src: "memory/chipswap/v4.mo" },
          5: { src: "memory/chipswap/v5.mo" },
          6: { src: "memory/chipswap/v6.mo" },
        },
        migrations: [
          { from: 1, to: 2, src: "memory/chipswap/v1_to_v2.mo" },
          { from: 2, to: 3, src: "memory/chipswap/v2_to_v3.mo" },
          { from: 3, to: 4, src: "memory/chipswap/v3_to_v4.mo" },
          { from: 4, to: 5, src: "memory/chipswap/v4_to_v5.mo" },
          { from: 5, to: 6, src: "memory/chipswap/v5_to_v6.mo" },
        ],
      },
    },
  });
  expect(manifest).not.toHaveProperty("init_arg");
});

test("chipswap declares three paid routes and two free ones", async () => {
  const manifest = await readManifest();

  expect(manifest.capabilities?.public_ingress).toMatchObject({
    api: 1,
    routes: [
      // Reading a catalog is a query for the same reason crawling is: it
      // writes nothing and records nothing about who asked, so it charges
      // nothing either. It admits any caller because the browser reads it
      // directly now, and a tile is credentialless — its query is anonymous or
      // it does not happen.
      {
        protocol: "chipswap_v1",
        id: "catalog",
        handler: "chipswap_catalog_v1",
        mode: "query",
        caller: "any",
        max_request_bytes: 1024,
        max_response_bytes: 65536,
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
      // The crawl's route is a query: it reads, it cannot write, and so it
      // declares no cycles floor and no rate limit. A peer's crawl costs us
      // nothing and tells us nothing, which is the trade it makes.
      {
        protocol: "chipswap_v1",
        id: "directory",
        handler: "chipswap_directory_v1",
        mode: "query",
        caller: "canister",
        max_request_bytes: 1024,
        max_response_bytes: 8192,
      },
    ],
  });

  // A subset match would not notice a floor left behind, and the kernel
  // refuses a query route that carries one at all. Both free routes are held
  // to that here rather than trusted to the shape above.
  for (const id of ["catalog", "directory"]) {
    const free = routes(manifest).find((route) => route.id === id);
    expect(free?.mode).toBe("query");
    expect(free).not.toHaveProperty("required_cycles");
    expect(free).not.toHaveProperty("max_calls_per_hour");
    expect(free).not.toHaveProperty("max_calls_per_caller_per_hour");
  }

  const directoryRoute = routes(manifest).find((route) => route.id === "directory");
  // A full page of principals fits inside what the route will return.
  expect(directoryRoute?.max_response_bytes ?? 0).toBeGreaterThanOrEqual(128 * 30);

  // A full catalog fits inside what the route will return, and the decoder on
  // the other end accepts exactly that much: Wire.MAX_MESSAGE_BYTES.
  const catalogRoute = routes(manifest).find((route) => route.id === "catalog");
  expect(catalogRoute?.max_response_bytes).toBe(65536);

  // Nothing announces any more: discovery is a pull, and the push is gone.
  expect(routes(manifest).map((route) => route.id)).not.toContain("announce");

  // Every route handler takes the kernel-supplied caller and nothing else, in
  // whichever mode its route declares.
  for (const route of routes(manifest)) {
    expect(funcMap(manifest)[route.handler]).toEqual({
      type: route.mode,
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
    // Two dispatchers, because a query route is a different physical method
    // from an update one and each is reserved on its own.
    install_reservations: [
      { kind: "method", method: "app_chipswap__chipswap_v1_update" },
      { kind: "method", method: "app_chipswap__chipswap_v1_query" },
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

test("the catalog route admits a browser and the paid routes stay paid", async () => {
  const manifest = await readManifest();
  const all = routes(manifest);

  // A tile is credentialless and never holds the owner's identity, so a
  // browser-originated query arrives anonymous. "authenticated" would refuse
  // it and "canister" refuses it today.
  const catalog = all.find((route) => route.id === "catalog");
  expect(catalog).toMatchObject({ mode: "query", caller: "any" });
  expect(catalog).not.toHaveProperty("required_cycles");

  // Widening one query route is not a licence to widen the rest. The directory
  // route still serves canisters, and the three update routes still cost a
  // caller cycles.
  const directory = all.find((route) => route.id === "directory");
  expect(directory).toMatchObject({ mode: "query", caller: "canister" });

  for (const id of ["trade", "deliver", "status"]) {
    const route = all.find((entry) => entry.id === id);
    expect(route).toMatchObject({ mode: "update", caller: "canister" });
    expect(route?.required_cycles).toBeGreaterThan(0);
  }
});

test("the background is declared with persistent browser storage", async () => {
  const manifest = await readManifest();

  // Tiles get no persistence, so a cache that survives a reload has to live in
  // a background with a persistent origin.
  expect(manifest.background).toMatchObject({ path: "service.html" });
  expect(manifest.capabilities?.persistent_browser_storage).toMatchObject({
    api: 1,
    surface: "background",
  });
  // The two resident capabilities are mutually exclusive.
  expect(manifest.capabilities).not.toHaveProperty("dedicated_resident_origin");
});

test("the removed catalog methods are gone from every surface", async () => {
  const manifest = await readManifest();
  const map = funcMap(manifest);
  const preapproved =
    manifest.capabilities?.preapproved_self_calls?.methods ?? [];
  const backend = await readBackend();

  for (const method of ["chipswap_store", "chipswap_fetch_catalogs"]) {
    expect(map).not.toHaveProperty(method);
    expect(preapproved).not.toContain(method);
    expect(backend).not.toContain(method);
  }
  // The cache they fed goes with them.
  expect(backend).not.toContain("catalog_cache");
});

test("the manifest and memory versions advanced together", async () => {
  const manifest = await readManifest();
  expect(manifest.version).toBe(116);
  expect(manifest.memory?.chipswap?.version).toBe(6);
});

test("the background ships with a policy that reaches the IC and nothing else", async () => {
  const html = await readFile(
    new URL("../dist/web/service.html", import.meta.url),
    "utf8",
  );

  // The background needs the gateway; it needs nothing else, and saying so in
  // the document is what keeps a bundled dependency from reaching further.
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("connect-src 'self' https://*.icp0.io");
  expect(html).toContain("./service.js");
  // A wildcard host or an inline script would defeat the point.
  expect(html).not.toMatch(/connect-src[^;]*\s\*/u);
  expect(html).not.toContain("'unsafe-inline'");
});

test("peer fetching lives in the background, not in the tile", async () => {
  const tile = await readFile(jsUrl, "utf8");
  const background = await readFile(
    new URL("../dist/web/service.js", import.meta.url),
    "utf8",
  );

  // The background is the only surface with persistence, so it is the only one
  // that should be talking to peers. A tile that also fetched would be a
  // second, cacheless path to the same data.
  expect(background).toContain("app_chipswap__chipswap_v1_query");
  expect(background).toContain("fetchRootKey");
  expect(tile).not.toContain("app_chipswap__chipswap_v1_query");
  expect(tile).not.toContain("fetchRootKey");
});
