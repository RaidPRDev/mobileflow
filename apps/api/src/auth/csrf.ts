import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";

export const CSRF_COOKIE = "mf_csrf";
export const CSRF_HEADER = "x-csrf-token";

// 32 random bytes encoded base64url → 43 chars. Plenty of entropy and small
// enough to fit comfortably in a cookie/header.
export function newCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

// CSRF cookie is intentionally NOT httpOnly — the SPA reads it from
// document.cookie and copies the value into the `X-CSRF-Token` header on
// state-changing requests (the "double-submit cookie" pattern). A
// cross-origin attacker can cause the browser to send the cookie back via
// CORS-credentialed request, but cannot read its value to forge the matching
// header. `sameSite=lax` is defense-in-depth: most modern browsers wouldn't
// send a credentialed POST cross-site anyway, but lax-mode top-level GETs
// (which we don't gate on CSRF) still ship the cookie.
export function setCsrfCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export function clearCsrfCookie(reply: FastifyReply) {
  reply.clearCookie(CSRF_COOKIE, {
    httpOnly: false,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
  });
}

// Methods that don't change server state never need CSRF protection — the
// risk model is "attacker site causes the browser to submit a form / fetch
// with side effects using ambient cookies", which only applies to writes.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Endpoints that intentionally accept un-authenticated or first-load requests
// where there is no session cookie yet. Without this exemption, login itself
// would require a CSRF token, which would have to come from a prior visit,
// breaking the cold-start flow. These endpoints set the CSRF cookie on
// success so subsequent writes are protected.
const EXEMPT_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/logout", // logout clears state — safe even if forged; better UX than 403
]);

function constantTimeEqual(a: string, b: string): boolean {
  // Avoid leaking length differences via a fast-path return.
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Fastify `onRequest` hook implementing double-submit-cookie CSRF protection
 * for cookie-authenticated writes. Skips:
 *   - safe methods (GET/HEAD/OPTIONS)
 *   - exempt auth bootstrap endpoints
 *   - bearer-token requests (no ambient credential to abuse, so CSRF is N/A)
 *
 * For everything else, requires `X-CSRF-Token` header to exactly match the
 * `mf_csrf` cookie (both non-empty) using constant-time comparison.
 */
export async function csrfGuard(req: FastifyRequest, reply: FastifyReply) {
  if (SAFE_METHODS.has(req.method)) return;
  if (EXEMPT_PATHS.has(req.url.split("?")[0]!)) return;

  // Bearer auth has no ambient-credential CSRF surface. We check the header
  // shape (not validity) because the request hasn't passed auth yet at this
  // hook stage — a bogus bearer will fail at requireUser, not here.
  const authz = req.headers.authorization;
  if (typeof authz === "string" && /^Bearer\s/i.test(authz)) return;

  const cookieToken = req.cookies[CSRF_COOKIE];
  const headerRaw = req.headers[CSRF_HEADER];
  const headerToken = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw;

  if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
    return reply.code(403).send({ error: "CsrfTokenMismatch" });
  }
}
