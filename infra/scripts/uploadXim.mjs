#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "../../apps/api/.env");

function step(label) {
  console.log(`\n[uploadXim] ${label}`);
}

function loadEnv(path) {
  if (!existsSync(path)) throw new Error(`.env not found at ${path}`);
  const env = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

function translateKeyPath(p) {
  if (!isWin) return p;
  // /mnt/d/foo/bar -> D:\foo\bar
  const m = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  return p;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: node uploadXim.mjs <local-file> [remote-path]");
    console.error("  remote-path defaults to ~/Downloads/<basename>");
    process.exit(2);
  }
  const localPath = resolve(args[0]);
  if (!existsSync(localPath)) throw new Error(`local file not found: ${localPath}`);
  const localStat = statSync(localPath);
  if (!localStat.isFile()) throw new Error(`not a file: ${localPath}`);

  const env = loadEnv(ENV_PATH);
  const host = env.MAC_BUILD_HOST;
  const port = env.MAC_BUILD_PORT || "22";
  const user = env.MAC_BUILD_USER;
  const keyPath = translateKeyPath(env.MAC_BUILD_SSH_KEY_PATH || "");

  if (!host || !user || !keyPath) {
    throw new Error("MAC_BUILD_HOST / MAC_BUILD_USER / MAC_BUILD_SSH_KEY_PATH must be set in .env");
  }
  if (!existsSync(keyPath)) throw new Error(`ssh key not found at ${keyPath}`);

  const remoteDefault = `~/Downloads/${basename(localPath)}`;
  const remotePath = args[1] || remoteDefault;
  const remoteTarget = `${user}@${host}:${remotePath}`;

  step(`source: ${localPath} (${formatBytes(localStat.size)})`);
  step(`target: ${remoteTarget}`);
  step(`key:    ${keyPath}`);
  step(`port:   ${port}`);

  const scpArgs = [
    "-i", keyPath,
    "-P", port,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=120",
    "-v",
    localPath,
    remoteTarget,
  ];

  step(`running: scp ${scpArgs.filter((a) => a !== "-v").join(" ")}`);
  const started = Date.now();
  const child = spawn("scp", scpArgs, { stdio: "inherit", shell: false });

  child.on("error", (err) => {
    console.error(`[uploadXim] failed to spawn scp: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (signal) {
      console.error(`[uploadXim] scp killed by signal ${signal} after ${secs}s`);
      process.exit(1);
    }
    if (code === 0) {
      const mbps = (localStat.size / 1024 / 1024 / (Number(secs) || 1)).toFixed(2);
      console.log(`\n[uploadXim] done in ${secs}s (~${mbps} MB/s)`);
    } else {
      console.error(`[uploadXim] scp exited with code ${code}`);
    }
    process.exit(code ?? 1);
  });
}

main().catch((err) => {
  console.error(`[uploadXim] ${err.message}`);
  process.exit(1);
});
