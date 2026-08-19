import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("chipswap manifest validates and declares its identity and tile", async () => {
  const manifest = await readManifest();

  expect(validate_neutron_conf(manifest).errors).toEqual([]);
  expect(manifest).toMatchObject({
    format: 3,
    id: "chipswap",
    name: "Chipswap",
    version: 100,
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
