// Verify all three signup-enumeration channels are closed:
//   1. BODY:    duplicate and new-user signups return identical `{ok: true}`
//   2. COOKIES: neither branch sets Set-Cookie (no auto-login)
//   3. TIMING:  wall-clock duration of both branches clusters at/above the
//               configured floor — an attacker can't distinguish via timing

import { assert, makeApp, run, test, uniqEmail, getDb, getSchema } from "./_harness.mjs";
import { eq, like } from "drizzle-orm";

test("duplicate-email signup returns the same body as a new signup", async () => {
  const app = await makeApp();
  const db = await getDb();
  const { users, organizations, orgMembers, subscriptions } = await getSchema();
  const email = uniqEmail("enum-body");
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "password-1234" },
      remoteAddress: "10.30.0.1",
    });
    const dupe = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "different-password" },
      remoteAddress: "10.30.0.2",
    });

    assert.equal(first.statusCode, 200);
    assert.equal(dupe.statusCode, 200);
    // Bytes-identical body.
    assert.equal(dupe.body, first.body, `bodies must match exactly: "${first.body}" vs "${dupe.body}"`);
    assert.equal(dupe.body, '{"ok":true}');

    // And nothing in the DB should have been created for the duplicate.
    const rows = await db.select().from(users).where(eq(users.email, email));
    assert.equal(rows.length, 1, "duplicate signup must not insert a second user row");
  } finally {
    const [u] = await db.select().from(users).where(eq(users.email, email));
    if (u) {
      const orgs = await db
        .select()
        .from(organizations)
        .where(eq(organizations.ownerUserId, u.id));
      for (const o of orgs) {
        await db.delete(subscriptions).where(eq(subscriptions.orgId, o.id));
        await db.delete(orgMembers).where(eq(orgMembers.orgId, o.id));
        await db.delete(organizations).where(eq(organizations.id, o.id));
      }
      await db.delete(users).where(eq(users.id, u.id));
    }
    await app.close();
  }
});

test("signup sets no session cookie on either branch", async () => {
  const app = await makeApp();
  const db = await getDb();
  const { users, organizations, orgMembers, subscriptions } = await getSchema();
  const email = uniqEmail("enum-ck");
  try {
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "password-1234" },
      remoteAddress: "10.31.0.1",
    });
    const dupe = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "another" },
      remoteAddress: "10.31.0.2",
    });

    const cookieKey = (res: typeof first) =>
      res.cookies.map((c) => c.name).sort().join(",");

    assert.equal(cookieKey(first), "", "new signup must not set Set-Cookie");
    assert.equal(cookieKey(dupe), "", "duplicate signup must not set Set-Cookie");
  } finally {
    const [u] = await db.select().from(users).where(eq(users.email, email));
    if (u) {
      const orgs = await db
        .select()
        .from(organizations)
        .where(eq(organizations.ownerUserId, u.id));
      for (const o of orgs) {
        await db.delete(subscriptions).where(eq(subscriptions.orgId, o.id));
        await db.delete(orgMembers).where(eq(orgMembers.orgId, o.id));
        await db.delete(organizations).where(eq(organizations.id, o.id));
      }
      await db.delete(users).where(eq(users.id, u.id));
    }
    await app.close();
  }
});

test("duplicate and new-user signups have indistinguishable wall-clock time", async () => {
  // Take 3 samples of each branch and compare medians. The floor in
  // routes/auth.ts is 500ms; both medians should land just above that and
  // within a small tolerance of each other. This is the strongest practical
  // assertion we can make without a high-resolution side-channel rig — the
  // point is to catch a regression where someone removes hashPassword from
  // the duplicate branch (which would crash the duplicate median to ~10ms).
  const app = await makeApp();
  const db = await getDb();
  const { users, organizations, orgMembers, subscriptions } = await getSchema();
  const TOLERANCE_MS = 80;
  const FLOOR_MIN_MS = 450;
  const newEmails: string[] = [];
  const dupeEmails: string[] = [];
  try {
    const SAMPLES = 3;
    const newTimes: number[] = [];
    const dupeTimes: number[] = [];
    let ipIdx = 0;
    for (let i = 0; i < SAMPLES; i++) {
      // Each new-branch run uses a unique email; signup auto-creates the row.
      const newEmail = uniqEmail("enum-tm-new");
      newEmails.push(newEmail);
      const t0 = Date.now();
      await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: newEmail, password: "password-1234" },
        remoteAddress: `10.32.0.${++ipIdx}`,
      });
      newTimes.push(Date.now() - t0);

      // For the duplicate branch we need a pre-existing row. Reuse the
      // first new email we just created — second signup with the same
      // address takes the duplicate path.
      const dupeEmail = newEmails[0]!;
      dupeEmails.push(dupeEmail);
      const t1 = Date.now();
      await app.inject({
        method: "POST",
        url: "/api/auth/signup",
        payload: { email: dupeEmail, password: "another-pass" },
        remoteAddress: `10.32.0.${++ipIdx}`,
      });
      dupeTimes.push(Date.now() - t1);
    }
    const median = (arr: number[]) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)]!;
    const mNew = median(newTimes);
    const mDupe = median(dupeTimes);
    assert.ok(
      mNew >= FLOOR_MIN_MS,
      `new-user median ${mNew}ms should be >= ${FLOOR_MIN_MS}ms (samples: ${newTimes.join(",")})`,
    );
    assert.ok(
      mDupe >= FLOOR_MIN_MS,
      `duplicate median ${mDupe}ms should be >= ${FLOOR_MIN_MS}ms (samples: ${dupeTimes.join(",")})`,
    );
    assert.ok(
      Math.abs(mNew - mDupe) <= TOLERANCE_MS,
      `branches differ by ${Math.abs(mNew - mDupe)}ms (>${TOLERANCE_MS}ms). new=${mNew}, dupe=${mDupe}, samples new=${newTimes.join(",")} dupe=${dupeTimes.join(",")}`,
    );
  } finally {
    // Orgs FK-reference users with onDelete: restrict — orgs must go first.
    const created = await db.select().from(users).where(like(users.email, "enum-tm-new-%"));
    for (const u of created) {
      const orgs = await db.select().from(organizations).where(eq(organizations.ownerUserId, u.id));
      for (const o of orgs) {
        await db.delete(subscriptions).where(eq(subscriptions.orgId, o.id));
        await db.delete(orgMembers).where(eq(orgMembers.orgId, o.id));
        await db.delete(organizations).where(eq(organizations.id, o.id));
      }
      await db.delete(users).where(eq(users.id, u.id));
    }
    await app.close();
  }
});

await run("signupEnum");
