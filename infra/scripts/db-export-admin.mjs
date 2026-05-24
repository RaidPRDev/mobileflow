#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CONTAINER = "mobileflow_dev_db";
const DB_USER = "mobileflow";
const DB_NAME = "mobileflow";
const TABLES = ["public.payment_processors", "public.oauth_apps"];
const OUT_PATH = "infra/seed/admin-seed.sql";
const isWin = process.platform === "win32";

function step(label) {
  console.log(`\n[db:export-admin] ${label}`);
}

function fail(msg) {
  console.error(`[db:export-admin] ${msg}`);
  process.exit(1);
}

function assertContainerRunning() {
  const r = spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", CONTAINER],
    { encoding: "utf8", shell: isWin },
  );
  const running = (r.stdout || "").trim() === "true";
  if (!running) {
    fail(
      `container "${CONTAINER}" is not running. Start it first with \`pnpm dev:up\` (or \`pnpm dev:db\`).`,
    );
  }
}

function runPgDump() {
  const args = [
    "exec",
    CONTAINER,
    "pg_dump",
    "-U",
    DB_USER,
    "-d",
    DB_NAME,
    "--data-only",
    "--column-inserts",
    "--no-owner",
    "--no-privileges",
  ];
  for (const t of TABLES) args.push("-t", t);

  const r = spawnSync("docker", args, { encoding: "utf8", shell: isWin });
  if (r.status !== 0) {
    console.error(r.stderr || "");
    fail(`pg_dump failed with exit ${r.status}`);
  }
  return r.stdout;
}

// pg_dump emits each row as a single-line `INSERT INTO ... VALUES (...);`.
// Rewrite to `INSERT INTO ... VALUES (...) ON CONFLICT DO NOTHING;` so the
// seed is idempotent across re-runs.
function makeIdempotent(sql) {
  return sql.replace(/^(INSERT INTO[\s\S]*?\));\s*$/gm, "$1 ON CONFLICT DO NOTHING;");
}

function buildHeader(rowCounts) {
  const now = new Date().toISOString();
  const lines = [
    "-- MobileFlow admin seed",
    `-- Generated: ${now}`,
    "-- Tables: payment_processors, oauth_apps",
    "--",
    "-- WARNING: secret columns (credentials_enc, config_enc, client_secret_enc)",
    "-- are AES-256-GCM ciphertext. They only decrypt if the same",
    "-- APP_ENCRYPTION_KEY (or equivalent) is set when imported. If you rotate",
    "-- the key, regenerate this file with `pnpm db:export-admin`.",
    "--",
    `-- Row counts at export: ${rowCounts.map(([t, n]) => `${t}=${n}`).join(", ")}`,
    "",
  ];
  return lines.join("\n");
}

function countRows(sql) {
  const counts = [];
  for (const table of TABLES) {
    const bare = table.replace(/^public\./, "");
    const re = new RegExp(`^INSERT INTO (?:public\\.)?${bare}\\b`, "gm");
    counts.push([bare, (sql.match(re) || []).length]);
  }
  return counts;
}

step(`exporting ${TABLES.join(", ")} from container "${CONTAINER}"`);
assertContainerRunning();
const raw = runPgDump();
const idempotent = makeIdempotent(raw);
const counts = countRows(idempotent);
const out = buildHeader(counts) + idempotent;

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, out, "utf8");

step(`wrote ${OUT_PATH}`);
for (const [t, n] of counts) console.log(`                   ${t}: ${n} row(s)`);
console.log(
  "\n[db:export-admin] done. After `pnpm dev:nuke` + `pnpm dev:up`, restore with `pnpm db:import-admin`.",
);
