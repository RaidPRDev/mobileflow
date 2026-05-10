#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const COMPOSE_FILE = "infra/.docker/dev.yml";
const IMAGE = "postgres:16-alpine";
const isWin = process.platform === "win32";

function step(label) {
  console.log(`\n[dev:nuke] ${label}`);
}

function run(cmd, args, { allowFailure = false } = {}) {
  console.log(`           $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: isWin });
  if (r.status !== 0 && !allowFailure) {
    console.error(`[dev:nuke] command failed with exit ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

function compose(args, opts) {
  const v2 = spawnSync("docker", ["compose", "version"], { shell: isWin });
  if (v2.status === 0) run("docker", ["compose", "-f", COMPOSE_FILE, ...args], opts);
  else run("docker-compose", ["-f", COMPOSE_FILE, ...args], opts);
}

console.log("[dev:nuke] this will stop and remove the Postgres container, drop");
console.log("           its volume (all DB data), and remove the postgres image.");

step("stopping and removing containers + volumes");
compose(["down", "-v"], { allowFailure: true });

step(`removing image ${IMAGE}`);
run("docker", ["image", "rm", IMAGE], { allowFailure: true });

console.log("\n[dev:nuke] done. Run `pnpm dev:up` to start fresh.");
