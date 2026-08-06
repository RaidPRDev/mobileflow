// bump-build.mjs
// Usage: node infra/scripts/bump-build.mjs [--type alpha|beta|rc|stable]
//
// Increments buildNumber and refreshes buildDate in the ROOT package.json —
// the single source of truth for the app's version/build identity (the web
// bundle embeds it at build time via rspack DefinePlugin).
//
// Called by .docker/.tools/start.prod.sh right before the workspace is zipped,
// so every deploy ships a fresh build number while the bumped file stays in
// the local working tree for the next deploy to increment again.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG_PATH = path.join(ROOT, "package.json");

const typeFlag = process.argv.indexOf("--type");
const nextType = typeFlag !== -1 ? process.argv[typeFlag + 1] : null;
const VALID_TYPES = ["alpha", "beta", "rc", "stable"];
if (nextType && !VALID_TYPES.includes(nextType)) {
  console.error(`Invalid --type "${nextType}" (expected: ${VALID_TYPES.join(", ")})`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));

pkg.buildNumber = (Number(pkg.buildNumber) || 0) + 1;
pkg.buildDate = new Date().toISOString();
pkg.buildType = nextType || pkg.buildType || "beta";

fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

console.log(`build: v${pkg.version} (${pkg.buildNumber}) ${pkg.buildType} — ${pkg.buildDate}`);
