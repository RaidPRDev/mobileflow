// Verify env.ts boot-time validation rejects misconfigurations that previously
// allowed insecure defaults to slip into production:
//
//   - COOKIE_SECRET shorter than 32 chars → exit 1
//   - NODE_ENV=production + TRUST_PROXY=true → exit 1
//   - NODE_ENV=production + missing SUPERADMIN_PASSWORD (with SUPERADMIN_EMAIL set) → exit 1
//   - NODE_ENV=production + COOKIE_SECRET matches a known placeholder → exit 1
//
// We can't test env.ts inside this process (env was already loaded by the
// harness). Instead we spawn the API entrypoint as a subprocess with a bad
// env and assert it dies non-zero before binding.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, run, assert } from "./_harness.mjs";

function readDotEnvKey(key: string): string | null {
  for (const f of [".env", ".env.local"]) {
    try {
      const text = readFileSync(resolve(apiRoot, f), "utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        if (line.slice(0, eq).trim() !== key) continue;
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        return v;
      }
    } catch {
      // file not present
    }
  }
  return null;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const apiRoot = resolve(here, "../..");
// Point at env.ts directly rather than server.ts. The validation we want to
// assert is all in env.ts; pointing at server.ts works in dev but causes
// some pnpm/tsx subprocess-spawn paths to hang before the validation gets
// a chance to print, which made the test flaky. env.ts is the unit under
// test anyway — exercising it directly is more honest.
const entry = resolve(apiRoot, "src/env.ts");
const tsxBin = resolve(
  apiRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsx.cmd" : "tsx",
);

// We deliberately INHERIT the full parent env (PATH, HOME, LANG, FNM_*, etc.
// needed by node/tsx to start) and then layer our overrides on top. Earlier
// we tried a strict whitelist and the subprocess silently hung — likely
// because tsx's loader couldn't find a runtime dep. We must explicitly
// scrub the credentials env vars we want each test to control, so a stray
// value in the parent (set by an earlier test or the harness defaults)
// doesn't mask a regression.
const SCRUB = [
  "NODE_ENV",
  "COOKIE_SECRET",
  "TRUST_PROXY",
  "SUPERADMIN_EMAIL",
  "SUPERADMIN_PASSWORD",
  "TESTERCLIENT_EMAIL",
  "TESTERCLIENT_PASSWORD",
];

function boot(envOverrides: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SCRUB.includes(k)) base[k] = v;
  }
  // Test-fixture baseline. The subprocess won't auto-bind because we set
  // COOKIE_SECRET below to a value that fails validation, so PORT/HOST don't
  // actually matter — but set them anyway in case a future test wants to
  // assert success.
  base.SKIP_DOTENV = "1"; // do not let a local .env override our test fixtures
  base.NODE_ENV = "development";
  base.COOKIE_SECRET = "valid-cookie-secret-32-bytes-of-rand-1234567890";
  base.TRUST_PROXY = "loopback";
  base.PORT = "4000"; // positive int — env.ts's PORT validation requires > 0
  base.HOST = "127.0.0.1";
  // DATABASE_URL must be present so the subprocess gets past the URL check
  // before our targeted assertion fires. If it's not exported, fall back
  // to reading apps/api/.env directly.
  if (!base.DATABASE_URL) base.DATABASE_URL = readDotEnvKey("DATABASE_URL") ?? "";
  if (!base.DATABASE_URL) {
    throw new Error(
      "envBoot tests require DATABASE_URL in the parent env or in apps/api/.env",
    );
  }
  const env = { ...base, ...envOverrides };
  return spawnSync(tsxBin, [entry], {
    env,
    encoding: "utf8",
    cwd: apiRoot,
    timeout: 10000,
    shell: process.platform === "win32",
  });
}

test("COOKIE_SECRET shorter than 32 chars exits 1", async () => {
  const r = boot({ COOKIE_SECRET: "tooshort" });
  assert.notEqual(r.status, 0, `expected non-zero exit, stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(
    (r.stderr ?? "") + (r.stdout ?? ""),
    /COOKIE_SECRET|Invalid environment/,
    "error output should mention COOKIE_SECRET",
  );
});

test("NODE_ENV=production + TRUST_PROXY=true exits 1", async () => {
  const r = boot({
    NODE_ENV: "production",
    TRUST_PROXY: "true",
    SUPERADMIN_PASSWORD: "a-strong-prod-password",
  });
  assert.notEqual(r.status, 0, `expected non-zero exit, stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(
    (r.stderr ?? "") + (r.stdout ?? ""),
    /TRUST_PROXY/i,
    "error output should mention TRUST_PROXY",
  );
});

test("production with placeholder COOKIE_SECRET exits 1", async () => {
  const r = boot({
    NODE_ENV: "production",
    // Pad to 32 chars so the length check passes; the placeholder check should fire.
    COOKIE_SECRET: "mobileflowmobileflowmobileflowxx",
    SUPERADMIN_PASSWORD: "a-strong-prod-password",
  });
  assert.notEqual(r.status, 0, `expected non-zero exit, stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(
    (r.stderr ?? "") + (r.stdout ?? ""),
    /placeholder|insecure/i,
    "error output should mention placeholder",
  );
});

test("production with SUPERADMIN_EMAIL but no SUPERADMIN_PASSWORD exits 1", async () => {
  const r = boot({
    NODE_ENV: "production",
    SUPERADMIN_EMAIL: "admin@example.com",
    // SUPERADMIN_PASSWORD intentionally unset (PASSTHROUGH excludes it).
  });
  assert.notEqual(r.status, 0, `expected non-zero exit, stdout=${r.stdout} stderr=${r.stderr}`);
});

await run("envBoot");
