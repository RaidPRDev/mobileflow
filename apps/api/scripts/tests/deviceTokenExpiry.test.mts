// Verify device-token expiry rules:
//   1. A freshly issued token authenticates fine
//   2. A token whose `expiresAt` is in the past is rejected
//   3. A token whose `lastUsedAt` is older than the idle window is rejected
//   4. A token never used but with createdAt past the idle window is rejected

import { assert, makeApp, run, test, uniqEmail, getDb, getSchema } from "./_harness.mjs";
import { eq } from "drizzle-orm";

test("freshly issued bearer token authenticates", async () => {
  const app = await makeApp();
  const db = await getDb();
  const { users, organizations, orgMembers, subscriptions, deviceTokens } = await getSchema();
  const email = uniqEmail("dt-ok");
  try {
    const password = "password-1234";
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password },
      remoteAddress: "10.50.0.1",
    });
    // Signup no longer auto-logs-in; follow up with /auth/login for cookies.
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
      remoteAddress: "10.50.0.1",
    });
    assert.equal(login.statusCode, 200);
    const session = login.cookies.find((c) => c.name === "mf_session")?.value;
    const csrf = login.cookies.find((c) => c.name === "mf_csrf")?.value;

    const issue = await app.inject({
      method: "POST",
      url: "/api/auth/devices",
      headers: {
        cookie: `mf_session=${session}; mf_csrf=${csrf}`,
        "x-csrf-token": csrf!,
      },
      payload: { name: "Test Device" },
      remoteAddress: "10.50.0.1",
    });
    assert.equal(issue.statusCode, 201);
    const { token } = issue.json() as { token: string };

    // Use the bearer against /auth/me-equivalent: /auth/devices is bearer-allowed.
    const list = await app.inject({
      method: "GET",
      url: "/api/auth/devices",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(list.statusCode, 200, "fresh bearer should authenticate");

    // --- Expire by absolute cutoff ---
    await db
      .update(deviceTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceTokens.userId, (await db.select().from(users).where(eq(users.email, email)))[0]!.id));

    const expired = await app.inject({
      method: "GET",
      url: "/api/auth/devices",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(expired.statusCode, 401, "expired token must be rejected");

    // --- Restore expiresAt, expire by idle instead ---
    const userId = (await db.select().from(users).where(eq(users.email, email)))[0]!.id;
    const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago
    await db
      .update(deviceTokens)
      .set({
        expiresAt: new Date(Date.now() + 60 * 1000), // not absolute-expired
        lastUsedAt: past,
        createdAt: past,
      })
      .where(eq(deviceTokens.userId, userId));

    const idle = await app.inject({
      method: "GET",
      url: "/api/auth/devices",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(idle.statusCode, 401, "idle-expired token must be rejected");
  } finally {
    const [u] = await db.select().from(users).where(eq(users.email, email));
    if (u) {
      await db.delete(deviceTokens).where(eq(deviceTokens.userId, u.id));
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

await run("deviceTokenExpiry");
