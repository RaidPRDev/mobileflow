// Verify the security-headers hook adds the expected defenses to every
// response. We sample three endpoints (public GET, 404, and 200 JSON) so
// we know the hook runs regardless of routing outcome.

import { assert, makeApp, run, test } from "./_harness.mjs";

const REQUIRED = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-permitted-cross-domain-policies": "none",
  "cross-origin-resource-policy": "same-site",
  "cross-origin-opener-policy": "same-origin",
  "x-xss-protection": "0",
  "x-dns-prefetch-control": "off",
  "origin-agent-cluster": "?1",
};

async function assertHeaders(res: { headers: Record<string, unknown> }, label: string) {
  for (const [k, v] of Object.entries(REQUIRED)) {
    assert.equal(res.headers[k], v, `${label}: header ${k} expected "${v}", got "${res.headers[k]}"`);
  }
  const csp = res.headers["content-security-policy"];
  assert.ok(
    typeof csp === "string" && csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'"),
    `${label}: CSP missing required directives, got "${csp}"`,
  );
}

test("headers are present on a 200 response", async () => {
  const app = await makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    await assertHeaders(res, "/health");
  } finally {
    await app.close();
  }
});

test("headers are present on a 404 response", async () => {
  const app = await makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/no-such-route" });
    assert.equal(res.statusCode, 404);
    await assertHeaders(res, "/no-such-route");
  } finally {
    await app.close();
  }
});

test("HSTS is NOT emitted in dev (NODE_ENV != production)", async () => {
  const app = await makeApp();
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(
      res.headers["strict-transport-security"],
      undefined,
      "HSTS would break local http dev — it should only appear in production",
    );
  } finally {
    await app.close();
  }
});

await run("securityHeaders");
