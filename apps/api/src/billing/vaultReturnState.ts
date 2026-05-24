import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

// Signed state token threaded through the processor's hosted-vault redirect.
// The user lands on /api/billing/<provider>-vault/return as a top-level
// navigation from PayPal/ConnectPay, so we can't rely on the session cookie
// (it's scoped to the SPA's origin, not the API's). The token authenticates
// the return request without ambient credentials.

const TTL_MS = 1000 * 60 * 30; // 30 minutes — covers a slow PayPal flow.

type Payload = { o: string; u: string; e: number };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", env.COOKIE_SECRET).update(payload).digest("base64url");
}

export function signVaultReturnState(orgId: string, userId: string): string {
  const payload: Payload = { o: orgId, u: userId, e: Date.now() + TTL_MS };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${body}.${sign(body)}`;
}

export function verifyVaultReturnState(
  token: string | undefined,
): { orgId: string; userId: string } | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig, "base64url");
  const b = Buffer.from(expected, "base64url");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: Payload;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (typeof parsed.o !== "string" || typeof parsed.u !== "string" || typeof parsed.e !== "number") {
    return null;
  }
  if (parsed.e <= Date.now()) return null;
  return { orgId: parsed.o, userId: parsed.u };
}
