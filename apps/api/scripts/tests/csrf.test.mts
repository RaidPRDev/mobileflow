// Verify the CSRF double-submit-cookie guard:
//   - cookie-authenticated POST without X-CSRF-Token → 403
//   - cookie-authenticated POST with matching token  → passes the guard
//   - bearer-authenticated POST does NOT require CSRF
//   - GET requests bypass

import { assert, makeApp, run, test, uniqEmail, getDb, getSchema, cookieValue } from "./_harness.mjs";
import { eq } from "drizzle-orm";

test("cookie-auth POST without X-CSRF-Token is 403", async () => {
  const app = await makeApp();
  const db = await getDb();
  const { users, organizations, orgMembers, subscriptions } = await getSchema();
  const email = uniqEmail("csrf");
  try {
    // Signup no longer auto-logs-in (enumeration mitigation). To get the
    // cookies needed for the CSRF test we follow up with /auth/login.
    const password = "password-1234";
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password },
      remoteAddress: "10.40.0.1",
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
      remoteAddress: "10.40.0.1",
    });
    assert.equal(login.statusCode, 200, `login after signup must succeed: ${login.body}`);
    const sessionCookie = cookieValue(login, "mf_session");
    const csrfCookie = cookieValue(login, "mf_csrf");
    assert.ok(sessionCookie && csrfCookie, "login must set both cookies");

    // Attempt a state-changing call with the session cookie but no CSRF header.
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/auth/devices",
      headers: { cookie: `mf_session=${sessionCookie}; mf_csrf=${csrfCookie}` },
      payload: { name: "test device" },
      remoteAddress: "10.40.0.1",
    });
    assert.equal(noCsrf.statusCode, 403, "missing CSRF header must be 403");
    assert.equal((noCsrf.json() as { error: string }).error, "CsrfTokenMismatch");

    // With the matching header it should get further (still may be 200/201).
    const withCsrf = await app.inject({
      method: "POST",
      url: "/api/auth/devices",
      headers: {
        cookie: `mf_session=${sessionCookie}; mf_csrf=${csrfCookie}`,
        "x-csrf-token": csrfCookie!,
      },
      payload: { name: "test device" },
      remoteAddress: "10.40.0.1",
    });
    assert.notEqual(withCsrf.statusCode, 403, "matching CSRF header must bypass the guard");
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

test("bearer-auth POST does not require CSRF", async () => {
  // The CSRF guard checks the Authorization header before the cookie path
  // and skips entirely when a Bearer token is present — there's no ambient-
  // credential vector. We exercise that branch by sending a malformed
  // bearer; the request should be rejected by requireUser (401), NOT by the
  // CSRF guard (403).
  const app = await makeApp();
  try {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/auth/devices/00000000-0000-0000-0000-000000000000",
      headers: { authorization: "Bearer mfd_doesnotexist" },
    });
    assert.notEqual(res.statusCode, 403, `bearer path should skip CSRF, got ${res.statusCode}`);
    assert.equal(res.statusCode, 401, "expected 401 from requireUser, not CSRF 403");
  } finally {
    await app.close();
  }
});

test("safe methods (GET) bypass CSRF entirely", async () => {
  const app = await makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/auth/captcha" });
    assert.equal(res.statusCode, 200, "GET should never require CSRF");
  } finally {
    await app.close();
  }
});

await run("csrf");
