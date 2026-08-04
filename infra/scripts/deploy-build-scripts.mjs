#!/usr/bin/env node
// Pushes the build-tool trees under `infra/tools/RaidX/Tools/{android,ios}/`
// to their respective servers (Linux Android host, macOS iOS host).
//
// Usage:
//   node infra/scripts/deploy-build-scripts.mjs              # both platforms
//   node infra/scripts/deploy-build-scripts.mjs --android    # only Android
//   node infra/scripts/deploy-build-scripts.mjs --ios        # only iOS
//   node infra/scripts/deploy-build-scripts.mjs --dry-run    # show, don't push
//
// Each platform runs an idempotent bootstrap after its tree is pushed — a
// no-op when the host is already in shape. Pass --no-requirements to skip.
//   iOS     : Support/Scripts/ensure_requirements.sh installs missing build
//             tooling (CocoaPods, xcbeautify) via Homebrew.
//   Android : ensure_image.sh rebuilds the Docker builder image, but only when
//             the deployed Dockerfile no longer matches the one the current
//             image was built from.
//
// Credentials come from apps/api/.env (same source as the worker).

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const ENV_PATH = resolve(REPO_ROOT, "apps/api/.env");

const ANDROID_LOCAL = resolve(REPO_ROOT, "infra/tools/RaidX/Tools/android");
const IOS_LOCAL = resolve(REPO_ROOT, "infra/tools/RaidX/Tools/ios");

function log(label, msg) {
  console.log(`[deploy:${label}] ${msg}`);
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

// `/mnt/d/foo/bar` → `D:\foo\bar` when running on Windows.
function translateKeyPath(p) {
  if (!isWin || !p) return p;
  const m = /^\/mnt\/([a-z])\/(.*)$/i.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
  return p;
}

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  const both = !flags.has("--android") && !flags.has("--ios");
  return {
    android: both || flags.has("--android"),
    ios: both || flags.has("--ios"),
    dryRun: flags.has("--dry-run"),
    requirements: !flags.has("--no-requirements"),
  };
}

function commonSshOpts(keyPath, port) {
  // -O forces legacy SCP transfer mode; sftp-mode (the OpenSSH 9 default) is
  // pickier about non-existent remote dirs and breaks the `dir/.` idiom.
  return [
    "-O",
    "-i", keyPath,
    "-P", String(port),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "IdentitiesOnly=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=120",
  ];
}

function commonSshOptsForSsh(keyPath, port) {
  // ssh uses lowercase -p (scp uses uppercase -P), and has no -O.
  return [
    "-i", keyPath,
    "-p", String(port),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "IdentitiesOnly=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=120",
  ];
}

function runSync(label, cmd, args, { dryRun }) {
  const printable = `${cmd} ${args.join(" ")}`;
  if (dryRun) {
    log(label, `DRY RUN: ${printable}`);
    return 0;
  }
  log(label, `$ ${printable}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (r.error) throw new Error(`spawn failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} exited with code ${r.status}`);
  return 0;
}

function deployTree({ label, localDir, host, port, user, keyPath, remoteDir, dryRun }) {
  if (!existsSync(localDir)) throw new Error(`local dir not found: ${localDir}`);
  const st = statSync(localDir);
  if (!st.isDirectory()) throw new Error(`not a directory: ${localDir}`);
  if (!host || !user || !keyPath) {
    throw new Error(`${label}: host/user/key not configured in .env`);
  }
  if (!existsSync(keyPath)) throw new Error(`ssh key not found at ${keyPath}`);
  if (!remoteDir) throw new Error(`${label}: remote tools dir not configured in .env`);

  log(label, `source : ${localDir}`);
  log(label, `target : ${user}@${host}:${remoteDir}`);
  log(label, `key    : ${keyPath}`);

  // Ensure remote dir exists.
  runSync(
    label,
    "ssh",
    [...commonSshOptsForSsh(keyPath, port), `${user}@${host}`, `mkdir -p '${remoteDir}'`],
    { dryRun }
  );

  // Windows' bundled OpenSSH scp doesn't expand `dir/.` to "contents of dir"
  // even in legacy mode (-O), so we enumerate top-level entries and pass them
  // as explicit sources. -p preserves modes (notably exec bits) and mtimes.
  // -r recursive. scp does not delete remote-only files — intentional, so a
  // stale local checkout doesn't wipe ad-hoc fixes on the build host.
  const entries = readdirSync(localDir);
  if (entries.length === 0) throw new Error(`${label}: source dir is empty: ${localDir}`);
  const sources = entries.map((name) => join(localDir, name));
  runSync(
    label,
    "scp",
    [
      ...commonSshOpts(keyPath, port),
      "-r",
      "-p",
      ...sources,
      `${user}@${host}:${remoteDir}/`,
    ],
    { dryRun }
  );

  log(label, "✅ done");
}

// Runs the just-deployed bootstrap on the Mac: checks the build toolchain and
// brew-installs whatever is missing. Uses `bash -lc` so the remote environment
// matches what the build worker itself gets (see macRunner.ts).
function ensureMacRequirements({ label, host, port, user, keyPath, remoteDir, dryRun }) {
  const remoteScript = `${remoteDir}/Support/Scripts/ensure_requirements.sh`;
  log(label, `requirements: ${user}@${host}:${remoteScript}`);
  runSync(
    label,
    "ssh",
    [
      ...commonSshOptsForSsh(keyPath, port),
      `${user}@${host}`,
      `bash -lc 'bash "${remoteScript}"'`,
    ],
    { dryRun }
  );
  log(label, "✅ requirements ok");
}

// Rebuilds the Android builder image on the Linux host when the Dockerfile we
// just deployed differs from the one the current image was built from. Without
// this a Dockerfile change deploys but never takes effect.
function ensureAndroidImage({ label, host, port, user, keyPath, remoteDir, image, dryRun }) {
  const remoteScript = `${remoteDir}/ensure_image.sh`;
  log(label, `builder image: ${image || "(default)"}`);
  runSync(
    label,
    "ssh",
    [
      ...commonSshOptsForSsh(keyPath, port),
      `${user}@${host}`,
      `bash "${remoteScript}"${image ? ` "${image}"` : ""}`,
    ],
    { dryRun }
  );
  log(label, "✅ builder image ok");
}

function main() {
  const opts = parseArgs(process.argv);
  const env = loadEnv(ENV_PATH);

  if (opts.dryRun) log("init", "DRY RUN — no remote writes will occur");

  if (opts.android) {
    const linuxTarget = {
      label: "android",
      host: env.LINUX_BUILD_HOST,
      port: env.LINUX_BUILD_PORT || "22",
      user: env.LINUX_BUILD_USER,
      keyPath: translateKeyPath(env.LINUX_BUILD_SSH_KEY_PATH || ""),
      remoteDir: env.LINUX_BUILD_ANDROID_TOOLS,
      dryRun: opts.dryRun,
    };
    deployTree({ ...linuxTarget, localDir: ANDROID_LOCAL });
    // After the push, so the Dockerfile it hashes is the one we just sent.
    if (opts.requirements) {
      ensureAndroidImage({ ...linuxTarget, image: env.LINUX_BUILD_ANDROID_IMAGE });
    } else {
      log("android", "skipping builder image check (--no-requirements)");
    }
  }

  if (opts.ios) {
    const macTarget = {
      label: "ios",
      host: env.MAC_BUILD_HOST,
      port: env.MAC_BUILD_PORT || "22",
      user: env.MAC_BUILD_USER,
      keyPath: translateKeyPath(env.MAC_BUILD_SSH_KEY_PATH || ""),
      remoteDir: env.MAC_BUILD_TOOLS,
      dryRun: opts.dryRun,
    };
    deployTree({ ...macTarget, localDir: IOS_LOCAL });
    // Deliberately after the push, so the bootstrap that runs is the one we
    // just deployed rather than whatever version the Mac had.
    if (opts.requirements) {
      ensureMacRequirements(macTarget);
    } else {
      log("ios", "skipping requirements check (--no-requirements)");
    }
  }

  log("done", "all targets complete");
}

try {
  main();
} catch (err) {
  console.error(`[deploy] ${err.message}`);
  process.exit(1);
}
