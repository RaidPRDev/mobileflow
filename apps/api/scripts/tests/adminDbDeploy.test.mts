// Verify the two superadmin-only admin surfaces:
//
//   /admin/db/*      — table browser. Non-superadmins are refused, credential
//                      columns never come back, and identifiers can only name
//                      tables that exist in the schema.
//   /admin/deploy/*  — local deploy runner. Listing and guard rails only; this
//                      suite never starts a job, because a real run would SSH
//                      to the actual build hosts.

process.env.TOKEN_ENC_KEY ??= "2b".repeat(32);

import { assert, makeApp, run, test, uniqEmail, getDb, getSchema, cookieValue } from "./_harness.mjs";
import { eq } from "drizzle-orm";

interface Ctx {
  app: Awaited<ReturnType<typeof makeApp>>;
  cookie: string;
  csrf: string;
  email: string;
  userId: string;
}

async function setup(opts: { superadmin: boolean }): Promise<Ctx> {
  const app = await makeApp();
  const db = await getDb();
  const { users } = await getSchema();
  const email = uniqEmail("admindb");
  const password = "password-1234";
  await app.inject({ method: "POST", url: "/api/auth/signup", payload: { email, password }, remoteAddress: "10.42.0.1" });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, remoteAddress: "10.42.0.1" });
  assert.equal(login.statusCode, 200, `login failed: ${login.body}`);
  const csrf = cookieValue(login, "mf_csrf")!;
  const cookie = `mf_session=${cookieValue(login, "mf_session")}; mf_csrf=${csrf}`;
  const [u] = await db.select().from(users).where(eq(users.email, email));
  if (opts.superadmin) {
    await db.update(users).set({ isSuperadmin: true }).where(eq(users.id, u!.id));
  }
  return { app, cookie, csrf, email, userId: u!.id };
}

async function teardown(ctx: Ctx): Promise<void> {
  const db = await getDb();
  const { users, organizations, orgMembers, subscriptions } = await getSchema();
  const [u] = await db.select().from(users).where(eq(users.email, ctx.email));
  if (u) {
    const orgs = await db.select().from(organizations).where(eq(organizations.ownerUserId, u.id));
    for (const o of orgs) {
      await db.delete(subscriptions).where(eq(subscriptions.orgId, o.id));
      await db.delete(orgMembers).where(eq(orgMembers.orgId, o.id));
      await db.delete(organizations).where(eq(organizations.id, o.id));
    }
    await db.delete(users).where(eq(users.id, u.id));
  }
  await ctx.app.close();
}

const get = (ctx: Ctx, url: string) =>
  ctx.app.inject({ method: "GET", url, headers: { cookie: ctx.cookie } });
const mutate = (ctx: Ctx, method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  ctx.app.inject({
    method,
    url,
    headers: { cookie: ctx.cookie, "x-csrf-token": ctx.csrf },
    ...(payload === undefined ? {} : { payload }),
  });

test("non-superadmin is refused from both surfaces", async () => {
  const ctx = await setup({ superadmin: false });
  try {
    // requireSuperadmin answers 404, not 403, so the admin surface doesn't
    // advertise its own existence to a signed-in non-admin. These routes
    // inherit that by using the same guard.
    for (const url of ["/api/admin/db/tables", "/api/admin/deploy/targets"]) {
      const res = await get(ctx, url);
      assert.equal(res.statusCode, 404, `${url} should be 404 for a normal user, got ${res.statusCode}`);
    }
    const write = await mutate(ctx, "PATCH", "/api/admin/db/tables/users/rows", {
      pk: { id: ctx.userId },
      values: { name: "nope" },
    });
    assert.equal(write.statusCode, 404, "writes are refused too, not just reads");
  } finally {
    await teardown(ctx);
  }
});

test("table list covers the schema and reports hidden columns", async () => {
  const ctx = await setup({ superadmin: true });
  try {
    const res = await get(ctx, "/api/admin/db/tables");
    assert.equal(res.statusCode, 200, res.body);
    const tables = res.json() as { name: string; rowCount: number | null; hiddenColumnCount: number; primaryKey: string[] }[];
    const users = tables.find((t) => t.name === "users");
    assert.ok(users, "users table must be listed");
    assert.deepEqual(users!.primaryKey, ["id"]);
    assert.ok(users!.rowCount != null && users!.rowCount > 0, "users should have rows");
    assert.ok(
      users!.hiddenColumnCount > 0,
      "users has password_hash, so at least one column must be hidden",
    );
    // git_connections stores OAuth tokens — every *_enc column must be hidden.
    const conns = tables.find((t) => t.name === "git_connections");
    assert.ok(conns && conns.hiddenColumnCount >= 2, "git_connections must hide its token columns");
  } finally {
    await teardown(ctx);
  }
});

test("credential columns are never returned in rows", async () => {
  const ctx = await setup({ superadmin: true });
  try {
    const res = await get(ctx, "/api/admin/db/tables/users/rows?limit=5");
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as {
      columns: { name: string; sensitive: boolean }[];
      rows: Record<string, unknown>[];
    };
    const pwCol = body.columns.find((c) => c.name === "password_hash");
    assert.ok(pwCol, "password_hash should still be described in metadata");
    assert.equal(pwCol!.sensitive, true, "password_hash must be flagged sensitive");
    assert.ok(body.rows.length > 0, "expected at least the test user");
    for (const row of body.rows) {
      assert.ok(
        !("password_hash" in row),
        "password_hash must be absent from row payloads entirely, not merely masked",
      );
      assert.ok("email" in row, "non-sensitive columns should still be present");
    }
  } finally {
    await teardown(ctx);
  }
});

test("unknown or injected table names are rejected, not executed", async () => {
  const ctx = await setup({ superadmin: true });
  try {
    for (const name of ["not_a_table", "users; drop table users", "users--", "pg_shadow"]) {
      const res = await get(ctx, `/api/admin/db/tables/${encodeURIComponent(name)}/rows`);
      assert.equal(res.statusCode, 404, `"${name}" should be 404, got ${res.statusCode}: ${res.body}`);
    }
    // pg_shadow really does exist in Postgres — 404 proves the allow-list is the
    // schema registry, not "whatever the database happens to have".
    const still = await get(ctx, "/api/admin/db/tables/users/rows?limit=1");
    assert.equal(still.statusCode, 200, "the real table still works afterwards");
  } finally {
    await teardown(ctx);
  }
});

test("editing a row works; protected and key columns are refused", async () => {
  const ctx = await setup({ superadmin: true });
  try {
    const ok = await mutate(ctx, "PATCH", "/api/admin/db/tables/users/rows", {
      pk: { id: ctx.userId },
      values: { name: "Renamed By Test" },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((ok.json() as { row: { name: string } }).row.name, "Renamed By Test");

    const secret = await mutate(ctx, "PATCH", "/api/admin/db/tables/users/rows", {
      pk: { id: ctx.userId },
      values: { password_hash: "hunter2" },
    });
    assert.equal(secret.statusCode, 400, "password_hash must not be writable");

    const pk = await mutate(ctx, "PATCH", "/api/admin/db/tables/users/rows", {
      pk: { id: ctx.userId },
      values: { id: "00000000-0000-0000-0000-000000000000" },
    });
    assert.equal(pk.statusCode, 400, "primary keys must not be rewritable");

    const bogus = await mutate(ctx, "PATCH", "/api/admin/db/tables/users/rows", {
      pk: { id: ctx.userId },
      values: { nope: 1 },
    });
    assert.equal(bogus.statusCode, 400, "unknown columns must be refused");

    const badPk = await mutate(ctx, "PATCH", "/api/admin/db/tables/users/rows", {
      pk: { email: ctx.email },
      values: { name: "x" },
    });
    assert.equal(badPk.statusCode, 400, "pk must name the real primary key");
  } finally {
    await teardown(ctx);
  }
});

test("you cannot delete your own user row", async () => {
  const ctx = await setup({ superadmin: true });
  try {
    const res = await mutate(ctx, "DELETE", "/api/admin/db/tables/users/rows", {
      pk: { id: ctx.userId },
    });
    assert.equal(res.statusCode, 400, `expected refusal, got ${res.statusCode}: ${res.body}`);
    const db = await getDb();
    const { users } = await getSchema();
    const [still] = await db.select().from(users).where(eq(users.id, ctx.userId));
    assert.ok(still, "the row must still be there");
  } finally {
    await teardown(ctx);
  }
});

test("search and paging narrow the result set", async () => {
  const ctx = await setup({ superadmin: true });
  try {
    const hit = await get(ctx, `/api/admin/db/tables/users/rows?q=${encodeURIComponent(ctx.email)}`);
    assert.equal(hit.statusCode, 200, hit.body);
    const body = hit.json() as { rows: { email: string }[]; total: number };
    assert.equal(body.total, 1, "the search should match exactly this test user");
    assert.equal(body.rows[0]!.email, ctx.email);

    const miss = await get(ctx, "/api/admin/db/tables/users/rows?q=zzz-no-such-user-zzz");
    assert.equal((miss.json() as { total: number }).total, 0);

    const badSort = await get(ctx, "/api/admin/db/tables/users/rows?orderBy=password_hash");
    assert.equal(badSort.statusCode, 400, "sorting by a hidden column must be refused");
  } finally {
    await teardown(ctx);
  }
});

test("deploy targets list, and bad ids are refused without spawning anything", async () => {
  const ctx = await setup({ superadmin: true });
  try {
    const res = await get(ctx, "/api/admin/deploy/targets");
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { enabled: boolean; targets: { id: string; available: boolean }[] };
    assert.equal(body.enabled, true, "local deploy is enabled outside production");
    const ids = body.targets.map((t) => t.id);
    assert.deepEqual(ids, ["build-tools-ios", "build-tools-android", "build-tools-all"]);
    assert.ok(
      body.targets.every((t) => t.available),
      "deploy-build-scripts.mjs should be present in this checkout",
    );

    const unknown = await mutate(ctx, "POST", "/api/admin/deploy/targets/rm-rf/run");
    assert.equal(unknown.statusCode, 404, "an unknown target must never reach spawn()");

    const jobs = await get(ctx, "/api/admin/deploy/jobs");
    assert.equal(jobs.statusCode, 200);
    assert.equal((jobs.json() as { runningId: string | null }).runningId, null);

    const noJob = await mutate(ctx, "POST", "/api/admin/deploy/jobs/does-not-exist/cancel");
    assert.equal(noJob.statusCode, 404);
  } finally {
    await teardown(ctx);
  }
});

await run("admin-db-deploy");
