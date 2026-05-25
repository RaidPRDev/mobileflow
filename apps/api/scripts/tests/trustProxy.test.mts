// Verify that with TRUST_PROXY=false, the server ignores X-Forwarded-For and
// treats req.ip as the actual socket peer. This is what protects rate-limit
// keys from being spoofed by a malicious client setting their own
// X-Forwarded-For header.

import { test, run, assert, makeApp } from "./_harness.mjs";

// Lock TRUST_PROXY off for this run *before* importing the server.
process.env.TRUST_PROXY = "false";

test("X-Forwarded-For is not honoured when TRUST_PROXY=false", async () => {
  const app = await makeApp();
  try {
    // We can't read req.ip from outside the request lifecycle, so instead we
    // exercise the rate limiter: if X-Forwarded-For were honoured, varying
    // it per request would let an attacker rotate through "different IPs"
    // and never trip the per-IP limit. With it ignored, the same socket
    // peer (default 127.0.0.1 in inject) tracks across requests and the
    // per-IP cap fires.
    let saw429 = false;
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "spoof@mf-test.local", password: "wrong" },
        headers: { "x-forwarded-for": `10.0.0.${i + 1}` },
      });
      if (res.statusCode === 429) {
        saw429 = true;
        break;
      }
    }
    assert.ok(saw429, "varying X-Forwarded-For should NOT bypass per-IP rate limit");
  } finally {
    await app.close();
  }
});

await run("trustProxy");
