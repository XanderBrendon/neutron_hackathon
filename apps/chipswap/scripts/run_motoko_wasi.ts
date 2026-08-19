// Diagnostic runner: compiles one Motoko program to WASI and executes it with
// node, which reports the exact source location of a failed assert. The normal
// interpreted runner reports only that the program failed.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { disposeMotokoCompiler, loadMotoko } from "neutron-motoko-wasm";
import { prepareMotokoProgram } from "neutron-scripts/src/motoko.js";
import { parsePackageString } from "neutron-scripts/src/walk.js";

const execute = promisify(execFile);
const appRoot = path.resolve(import.meta.dir, "..");
const targets = process.argv.slice(2);
if (targets.length === 0) {
  throw new Error("Usage: run_motoko_wasi.ts <test.mo> [test.mo ...]");
}

const sourceOutput = await execute("mops", ["sources"], { cwd: appRoot });
const packages = Object.fromEntries(
  Object.entries(
    parsePackageString(sourceOutput.stdout.replace(/\n/g, " ").trim()),
  ).map(([name, root]) => [name, path.resolve(appRoot, root)]),
);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "chipswap-motoko-"));
const mo = await loadMotoko();

try {
  for (const [index, target] of targets.entries()) {
    const prepared = await prepareMotokoProgram({
      compiler: mo,
      sourcePath: path.resolve(appRoot, target),
      packages,
      allowDangerous: true,
    });
    const compiled = await mo.wasm(prepared.entryPath, "wasi");
    const wasmPath = path.join(temporary, `${index}.wasm`);
    await fs.writeFile(wasmPath, compiled.wasm);
    await execute("node", ["--no-warnings", "scripts/run_wasi.mjs", wasmPath], {
      cwd: appRoot,
    });
    console.log(`Motoko test passed: ${target}`);
  }
} finally {
  await disposeMotokoCompiler();
  await fs.rm(temporary, { recursive: true, force: true });
}
