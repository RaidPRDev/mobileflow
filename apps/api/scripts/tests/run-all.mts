// Run every *.test.mts in this directory in sequence and report a pass/fail
// summary. Each test file is invoked in its own subprocess so module state
// (rate-limit buckets, Fastify instances) doesn't leak between suites.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const apiRoot = resolve(here, "../..");
const tsxBin = resolve(
  apiRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

const files = readdirSync(here)
  .filter((f) => f.endsWith(".test.mts"))
  .sort();

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(tsxBin, [resolve(here, f)], {
    stdio: "inherit",
    cwd: apiRoot,
    shell: process.platform === "win32",
  });
  if (r.status !== 0) failed++;
}

console.log(`\n========================================`);
console.log(`${files.length - failed}/${files.length} suites passed`);
console.log(`========================================`);
process.exit(failed > 0 ? 1 : 0);
