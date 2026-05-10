#!/usr/bin/env node
import { spawnSync, spawn } from "node:child_process";

const COMPOSE_FILE = "infra/.docker/dev.yml";
const CONTAINER = "mobileflow_dev_db";
const HEALTH_TIMEOUT_MS = 60_000;
const isWin = process.platform === "win32";

function step(label) {
  console.log(`\n[dev:up] ${label}`);
}

function run(cmd, args) {
  console.log(`         $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: isWin });
  if (r.status !== 0) {
    console.error(`[dev:up] command failed with exit ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

function compose(...args) {
  // docker compose (v2) is preferred; fall back to docker-compose
  const v2 = spawnSync("docker", ["compose", "version"], { shell: isWin });
  if (v2.status === 0) run("docker", ["compose", "-f", COMPOSE_FILE, ...args]);
  else run("docker-compose", ["-f", COMPOSE_FILE, ...args]);
}

async function waitHealthy() {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    const r = spawnSync(
      "docker",
      ["inspect", "-f", "{{.State.Health.Status}}", CONTAINER],
      { encoding: "utf8", shell: isWin },
    );
    last = (r.stdout || "").trim();
    if (last === "healthy") return;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`Postgres did not become healthy within ${HEALTH_TIMEOUT_MS}ms (last status: "${last}")`);
}

async function main() {
  step("starting Postgres container");
  compose("up", "-d");

  step("waiting for Postgres to be healthy");
  await waitHealthy();

  step("applying schema (drizzle-kit push)");
  run("pnpm", ["--filter", "@mobileflow/api", "db:push"]);

  step("seeding database");
  run("pnpm", ["--filter", "@mobileflow/api", "db:seed"]);

  step("starting API dev server (Ctrl+C to stop; Postgres keeps running)");
  const api = spawn("pnpm", ["--filter", "@mobileflow/api", "dev"], {
    stdio: "inherit",
    shell: isWin,
  });
  api.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(`[dev:up] ${err.message}`);
  process.exit(1);
});
