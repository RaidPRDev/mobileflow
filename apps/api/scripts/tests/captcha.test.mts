// Verify the captcha-after-failures flow:
//   1. After 3 failed logins, the email's next login attempt requires captcha
//   2. A correct captcha lets the real user in
//   3. A wrong captcha doesn't, and counts against the failure tally
//   4. A consumed captcha cannot be replayed

import { assert, makeApp, run, test, uniqEmail, getDb, getSchema } from "./_harness.mjs";
import { eq } from "drizzle-orm";

test("/auth/captcha issues a single-use challenge with SVG payload", async () => {
  const app = await makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/auth/captcha" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { id: string; imageSvg: string; imageDataUrl: string };
    assert.match(body.id, /^[0-9a-f-]{36}$/, "captcha id must be a uuid");
    assert.match(body.imageSvg, /^<svg /);
    assert.match(body.imageDataUrl, /^data:image\/svg\+xml;base64,/);
  } finally {
    await app.close();
  }
});

test("3 failed logins triggers captcha requirement, correct captcha lets user in", async () => {
  const app = await makeApp();
  const db = await getDb();
  const { users, loginAttempts, captchas } = await getSchema();
  const { hashPassword } = await import("../../src/auth/password.js");
  const email = uniqEmail("cap-ok");
  const password = "correct-horse-battery-staple-2";
  await db.insert(users).values({ email, passwordHash: await hashPassword(password) });
  // Clean any stale attempts from a prior aborted run.
  await db.delete(loginAttempts).where(eq(loginAttempts.email, email.toLowerCase()));

  try {
    // 3 wrong attempts → captcha gate now active for this email.
    for (let i = 0; i < 3; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "wrong" },
        remoteAddress: `10.0.${i}.1`,
      });
      assert.equal(r.statusCode, 401, `attempt ${i + 1} should be 401`);
    }

    // Probe the public "needs captcha" endpoint.
    const probe = await app.inject({
      method: "GET",
      url: `/api/auth/login/needs-captcha?email=${encodeURIComponent(email)}`,
    });
    const probeBody = probe.json() as { required: boolean; threshold: number };
    assert.equal(probeBody.required, true, "captcha must be required after 3 failures");
    assert.equal(probeBody.threshold, 3);

    // Right password, no captcha → still rejected.
    const noCaptcha = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
      remoteAddress: "10.0.9.1",
    });
    assert.equal(noCaptcha.statusCode, 401);
    assert.equal((noCaptcha.json() as { error: string }).error, "CaptchaRequired");

    // Solve the captcha and retry. We peek at the stored code through the
    // captcha module's test helper — the SVG itself isn't machine-readable
    // by design, so end-to-end OCR is not part of the test surface.
    const issue = await app.inject({ method: "GET", url: "/api/auth/captcha" });
    const { id: captchaId } = issue.json() as { id: string };
    const { _peekCaptchaCodeForTests } = await import("../../src/auth/captcha.js");
    const code = await _peekCaptchaCodeForTests(captchaId);
    assert.ok(code, "captcha code must exist in DB");

    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password, captchaId, captchaCode: code },
      remoteAddress: "10.0.10.1",
    });
    assert.equal(ok.statusCode, 200);
    const okBody = ok.json() as { user?: { email: string } };
    assert.equal(okBody.user?.email, email);

    // After successful login, failure ledger should be cleared.
    const remaining = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.email, email.toLowerCase()));
    assert.equal(remaining.length, 0, "successful login must clear loginAttempts");
  } finally {
    await db.delete(loginAttempts).where(eq(loginAttempts.email, email.toLowerCase()));
    await db.delete(captchas).where(eq(captchas.consumed, true));
    await db.delete(users).where(eq(users.email, email));
    await app.close();
  }
});

test("wrong captcha is rejected and counts as a failed attempt", async () => {
  const app = await makeApp();
  const db = await getDb();
  const { users, loginAttempts } = await getSchema();
  const { hashPassword } = await import("../../src/auth/password.js");
  const email = uniqEmail("cap-bad");
  await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword("password-1234") });

  try {
    // Trigger the gate.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "wrong" },
        remoteAddress: `10.1.${i}.1`,
      });
    }
    const issue = await app.inject({ method: "GET", url: "/api/auth/captcha" });
    const { id: captchaId } = issue.json() as { id: string };

    const before = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.email, email.toLowerCase()));
    const beforeN = before.length;

    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "password-1234", captchaId, captchaCode: "WRONG1" },
      remoteAddress: "10.1.9.1",
    });
    assert.equal(bad.statusCode, 401);
    assert.equal((bad.json() as { error: string }).error, "CaptchaRequired");

    const after = await db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.email, email.toLowerCase()));
    assert.ok(after.length > beforeN, "failed captcha must be recorded as an attempt");
  } finally {
    await db.delete(loginAttempts).where(eq(loginAttempts.email, email.toLowerCase()));
    await db.delete(users).where(eq(users.email, email));
    await app.close();
  }
});

test("a consumed captcha code cannot be replayed", async () => {
  const app = await makeApp();
  const db = await getDb();
  const { users, loginAttempts, captchas } = await getSchema();
  const { hashPassword } = await import("../../src/auth/password.js");
  const email = uniqEmail("cap-replay");
  const password = "another-good-password";
  await db.insert(users).values({ email, passwordHash: await hashPassword(password) });

  try {
    // Trip the gate
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "wrong" },
        remoteAddress: `10.2.${i}.1`,
      });
    }
    const issue = await app.inject({ method: "GET", url: "/api/auth/captcha" });
    const { id: captchaId } = issue.json() as { id: string };
    const { _peekCaptchaCodeForTests } = await import("../../src/auth/captcha.js");
    const code = (await _peekCaptchaCodeForTests(captchaId))!;

    const first = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password, captchaId, captchaCode: code },
    });
    assert.equal(first.statusCode, 200, "first use should succeed");

    // Re-trip the gate so the next replay attempt hits the captcha branch.
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "wrong" },
        remoteAddress: `10.2.${i + 10}.1`,
      });
    }
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password, captchaId, captchaCode: code },
    });
    assert.equal(replay.statusCode, 401, "consumed captcha must not let the user back in");
    assert.equal((replay.json() as { error: string }).error, "CaptchaRequired");
  } finally {
    await db.delete(loginAttempts).where(eq(loginAttempts.email, email.toLowerCase()));
    await db.delete(captchas).where(eq(captchas.consumed, true));
    await db.delete(users).where(eq(users.email, email));
    await app.close();
  }
});

await run("captcha");
