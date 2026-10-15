// Syncs the product display name from packages/shared/brand.json into config
// files that can't import it (currently the Tauri desktop config). Runs as
// `predev`/`prebuild` in apps/desktop; safe to run any time — it's a no-op
// when everything already matches.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { productName } = JSON.parse(
  readFileSync(resolve(root, "packages/shared/brand.json"), "utf8")
);

const tauriConfPath = resolve(root, "apps/desktop/src-tauri/tauri.conf.json");
const conf = JSON.parse(readFileSync(tauriConfPath, "utf8"));

let changed = false;
if (conf.productName !== productName) {
  conf.productName = productName;
  changed = true;
}
for (const win of conf.app?.windows ?? []) {
  if (win.title !== productName) {
    win.title = productName;
    changed = true;
  }
}

if (changed) {
  writeFileSync(tauriConfPath, JSON.stringify(conf, null, 2) + "\n");
  console.log(`[sync-brand] tauri.conf.json updated to "${productName}"`);
} else {
  console.log(`[sync-brand] tauri.conf.json already up to date ("${productName}")`);
}
