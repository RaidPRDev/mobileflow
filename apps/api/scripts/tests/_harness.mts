// Shared test harness for the security integration scripts.
//
// We import the Fastify server via the in-process `buildServer()` factory
// and dispatch requests through `app.inject()` so the suite needs no port
// binding, no undici, and no waiting for a listen call. The DB layer talks
// to whatever DATABASE_URL points to — tests use unique email prefixes and
// clean up the rows they create so they're safe to rerun against a shared
// dev DB.

import assert from "node:assert/strict";

// Make sure env vars are sane before src/env.ts is evaluated. The user can
// override these by exporting them before invoking the test script — these
// are *defaults* for the test harness only.
process.env.NODE_ENV ??= "development";
process.env.COOKIE_SECRET ??= "test-cookie-secret-32-bytes-of-rand-1234567890";
process.env.TRUST_PROXY ??= "false";

// Tests do not exercise OAuth providers; suppress provider-disabled warnings.
process.env.WEB_ORIGIN ??= "http://127.0.0.1:5173";

const tests: { name: string; fn: () => Promise<void> }[] = [];

export function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

export async function run(label: string): Promise<void> {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    process.stdout.write(`  ▸ ${t.name} ... `);
    try {
      await t.fn();
      pass++;
      console.log("ok");
    } catch (err) {
      fail++;
      console.log("FAIL");
      console.error(err);
    }
  }
  console.log(`\n${label}: ${pass} passed, ${fail} failed`);
  // Force exit — the postgres pool from db/client.ts keeps the event loop
  // alive otherwise (postgres.js doesn't expose a clean teardown that the
  // Fastify close hooks invoke). For a one-shot test runner that's the right
  // call; in long-running code we'd want pool.end() instead.
  process.exit(fail > 0 ? 1 : 0);
}

export { assert };

// Re-export the in-process server lazily — importing it eagerly would
// instantiate Fastify even for test files that only want utilities.
export async function makeApp() {
  const { buildServer } = await import("../../src/server.js");
  const { _resetAllForTests } = await import("../../src/lib/rateLimit.js");
  _resetAllForTests();
  return buildServer();
}

export async function getDb() {
  const { db } = await import("../../src/db/client.js");
  return db;
}

export async function getSchema() {
  return await import("../../src/db/schema.js");
}

/**
 * Generate a unique email so concurrent test runs / re-runs don't collide.
 * The `prefix` is descriptive (e.g. "rl-", "cap-") so debug rows in the DB
 * are obvious about which test left them.
 */
export function uniqEmail(prefix: string): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${r}@mf-test.local`;
}

/** Strip cookies out of a Fastify inject response into a `Name=Value; ...` string. */
export function cookieJar(res: { cookies: { name: string; value: string }[] }): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export function cookieValue(
  res: { cookies: { name: string; value: string }[] },
  name: string,
): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}
