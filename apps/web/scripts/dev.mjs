#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const preload = resolve(here, "../../../infra/scripts/silence-deprecations.cjs");
const isWin = process.platform === "win32";

const env = { ...process.env };
const requireFlag = `--require ${JSON.stringify(preload)}`;
env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${requireFlag}` : requireFlag;

const child = spawn("rspack", ["serve"], {
  stdio: "inherit",
  env,
  shell: isWin,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
