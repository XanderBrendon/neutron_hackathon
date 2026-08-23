// Writes test/fixtures/catalog_wire.{json,mo} from one Motoko generator.
//
// The interpreted runner reports only pass or fail, so the generator is driven
// through the compiler's run API directly, which hands back the program's
// stdout. Both fixture files come from the same run, which is what stops the
// TypeScript decoder and the Motoko one from being tested against different
// bytes. The WASI path would also work in principle, but this environment's
// Node refuses the compiler's table-element flags.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";

const execute = promisify(execFile);
const appRoot = path.resolve(import.meta.dir, "..");
const source = path.join(appRoot, "scripts/gen_wire_fixtures.mo");
const MARKER = "---MOTOKO---";

const sourceOutput = await execute("mops", ["sources"], { cwd: appRoot });
const packages = Object.fromEntries(
  Object.entries(
    parsePackageString(sourceOutput.stdout.replace(/\n/g, " ").trim()),
  ).map(([name, root]) => [name, path.resolve(appRoot, root)]),
);

const mo = await loadMotoko();

try {
  const prepared = await prepareMotokoProgram({
    compiler: mo,
    sourcePath: source,
    packages,
    allowDangerous: true,
  });
  const { stdout } = await mo.run(prepared.entryPath);

  const index = stdout.indexOf(MARKER);
  if (index < 0) throw new Error("The generator emitted no Motoko section");

  // The compiler may print diagnostics ahead of the payload, so the JSON is
  // taken from its opening brace rather than from the start of the stream.
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0 || jsonStart > index) {
    throw new Error("The generator emitted no JSON object");
  }
  const json = stdout.slice(jsonStart, index).trim();

  // The interpreter prints the program's own result value after the payload,
  // so the module is cut at its closing brace rather than at the end of the
  // stream. A stray `() : ()` on the end is a syntax error in a file whose
  // whole job is to be imported.
  const tail = stdout.slice(index + MARKER.length).trimEnd();
  const close = tail.lastIndexOf("\n}");
  if (close < 0) throw new Error("The Motoko section has no closing brace");
  const motoko = tail.slice(0, close + 2).trim();

  const parsed = JSON.parse(json) as {
    valid: Record<string, string>;
    invalid: Record<string, string>;
  };
  for (const [section, entries] of Object.entries(parsed)) {
    for (const [name, hex] of Object.entries(entries)) {
      if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
        throw new Error(`Fixture ${section}.${name} is not a byte string`);
      }
    }
  }

  await fs.mkdir(path.join(appRoot, "test/fixtures"), { recursive: true });
  await fs.writeFile(
    path.join(appRoot, "test/fixtures/catalog_wire.json"),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(appRoot, "test/fixtures/catalog_wire.mo"),
    `${motoko}\n`,
  );
  console.log(
    `wrote ${Object.keys(parsed.valid).length} valid and ` +
      `${Object.keys(parsed.invalid).length} invalid fixtures`,
  );
} finally {
  await disposeMotokoCompiler();
}
