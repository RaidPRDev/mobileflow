#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";

function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    const v = readFileSync("/proc/version", "utf8").toLowerCase();
    return v.includes("microsoft") || v.includes("wsl");
  } catch {
    return false;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, "..");
const watchTarget = resolve(apiRoot, "src");
const silencer = resolve(here, "../../../infra/scripts/silence-deprecations.cjs");
const isWin = process.platform === "win32";
const wsl = isWsl();

const env = { ...process.env };
const requireFlag = `--require ${JSON.stringify(silencer)}`;
env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${requireFlag}` : requireFlag;

if (wsl) console.log("[api dev] WSL detected — using polling file watcher");

let child = null;
let restartTimer = null;
let restarting = false;

function startServer() {
  child = spawn("tsx", ["src/server.ts"], {
    stdio: "inherit",
    env,
    shell: isWin,
    cwd: apiRoot,
  });
  child.on("exit", (code, signal) => {
    if (restarting) return; // we asked it to die
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

function restart(reason) {
  if (restarting) return;
  restarting = true;
  console.log(`\n[api dev] ${reason} — restarting…`);
  if (child && !child.killed) child.kill("SIGTERM");
  // Give the process a moment to release ports/handles before respawning.
  const respawn = () => {
    restarting = false;
    startServer();
  };
  if (child) child.once("exit", respawn);
  else respawn();
}

function scheduleRestart(reason) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => restart(reason), 100);
}

startServer();

const watcher = chokidar.watch(watchTarget, {
  ignored: /(^|[\\/])\../, // dotfiles
  ignoreInitial: true,
  usePolling: wsl,
  interval: 300,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
});

watcher.on("all", (event, file) => {
  if (event !== "add" && event !== "change" && event !== "unlink") return;
  const rel = relative(apiRoot, file);
  scheduleRestart(`${event} ${rel}`);
});

const shutdown = (sig) => {
  watcher.close();
  if (child && !child.killed) child.kill(sig);
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
