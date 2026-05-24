#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const CONTAINER = "mobileflow_dev_db";
const DB_USER = "mobileflow";
const DB_NAME = "mobileflow";
const TABLES = ["payment_processors", "oauth_apps"];
const IN_PATH = "infra/seed/admin-seed.sql";
const isWin = process.platform === "win32";

function step(label) {
  console.log(`\n[db:import-admin] ${label}`);
}

function fail(msg) {
  console.error(`[db:import-admin] ${msg}`);
  process.exit(1);
}

function assertContainerRunning() {
  const r = spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", CONTAINER],
    { encoding: "utf8", shell: isWin },
  );
  if ((r.stdout || "").trim() !== "true") {
    fail(
      `container "${CONTAINER}" is not running. Start it with \`pnpm dev:up\` first.`,
    );
  }
}

function assertTablesExist() {
  for (const t of TABLES) {
    const r = spawnSync(
      "docker",
      [
        "exec",
        CONTAINER,
        "psql",
        "-U",
        DB_USER,
        "-d",
        DB_NAME,
        "-tAc",
        `SELECT to_regclass('public.${t}') IS NOT NULL;`,
      ],
      { encoding: "utf8", shell: isWin },
    );
    if (r.status !== 0 || (r.stdout || "").trim() !== "t") {
      fail(
        `table public.${t} not found. Run drizzle migrations first (\`pnpm db:push\`), or use \`pnpm dev:up\` which applies the schema.`,
      );
    }
  }
}

function runImport() {
  const sql = readFileSync(IN_PATH, "utf8");
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      DB_USER,
      "-d",
      DB_NAME,
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: sql, encoding: "utf8", shell: isWin, stdio: ["pipe", "inherit", "inherit"] },
  );
  if (r.status !== 0) fail(`psql import failed with exit ${r.status}`);
}

function printCounts() {
  for (const t of TABLES) {
    const r = spawnSync(
      "docker",
      [
        "exec",
        CONTAINER,
        "psql",
        "-U",
        DB_USER,
        "-d",
        DB_NAME,
        "-tAc",
        `SELECT count(*) FROM public.${t};`,
      ],
      { encoding: "utf8", shell: isWin },
    );
    const n = (r.stdout || "").trim();
    console.log(`                   ${t}: ${n} row(s)`);
  }
}

if (!existsSync(IN_PATH)) {
  fail(`${IN_PATH} not found. Generate it first with \`pnpm db:export-admin\`.`);
}

step("checking container");
assertContainerRunning();

step("checking schema");
assertTablesExist();

step(`importing ${IN_PATH}`);
runImport();

step("row counts after import:");
printCounts();

console.log(
  "\n[db:import-admin] done. Reminder: encrypted columns only decrypt if APP_ENCRYPTION_KEY matches the value used at export time.",
);
