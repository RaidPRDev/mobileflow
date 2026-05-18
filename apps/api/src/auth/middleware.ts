import type { FastifyRequest, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { orgMembers, users } from "../db/schema.js";
import { SESSION_COOKIE, getSession } from "./session.js";
import { resolveDeviceToken, touchDeviceToken } from "./deviceToken.js";

declare module "fastify" {
  interface FastifyRequest {
    // `viaBearer` distinguishes desktop bearer-token requests from web
    // cookie-session requests so the CSRF guard knows to skip the former
    // (CSRF only protects ambient-credential requests, i.e. cookies).
    auth?: { userId: string; isSuperadmin: boolean; viaBearer: boolean };
  }
}

function readBearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  // Match `Bearer <token>` case-insensitively on the scheme. Trim once; do not
  // accept extra whitespace inside the token.
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  // Try bearer token first. Desktop / programmatic clients should always send
  // Authorization; if they accidentally also have a stale cookie we want the
  // bearer to win so the device-token audit trail is accurate.
  const bearer = readBearerToken(req);
  if (bearer) {
    const tok = await resolveDeviceToken(bearer);
    if (!tok) return reply.unauthorized();
    const [u] = await db
      .select({ id: users.id, isSuperadmin: users.isSuperadmin })
      .from(users)
      .where(eq(users.id, tok.userId))
      .limit(1);
    if (!u) return reply.unauthorized();
    req.auth = { userId: u.id, isSuperadmin: u.isSuperadmin, viaBearer: true };
    // Fire-and-forget audit update; failure here must not block the request.
    void touchDeviceToken(tok.id, req.ip).catch(() => {});
    return;
  }

  const id = req.cookies[SESSION_COOKIE];
  if (!id) return reply.unauthorized();
  const sess = await getSession(id);
  if (!sess) return reply.unauthorized();
  const [u] = await db
    .select({ id: users.id, isSuperadmin: users.isSuperadmin })
    .from(users)
    .where(eq(users.id, sess.userId))
    .limit(1);
  if (!u) return reply.unauthorized();
  req.auth = { userId: u.id, isSuperadmin: u.isSuperadmin, viaBearer: false };
}

export async function requireOrgMember(req: FastifyRequest, reply: FastifyReply, orgId: string) {
  if (!req.auth) return reply.unauthorized();
  if (req.auth.isSuperadmin) return; // superadmin sees all
  const [m] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, req.auth.userId)))
    .limit(1);
  if (!m) return reply.notFound(); // hide existence
}

/** Returns 404 (not 403) for non-superadmins to avoid leaking the admin surface. */
export async function requireSuperadmin(req: FastifyRequest, reply: FastifyReply) {
  await requireUser(req, reply);
  if (reply.sent) return;
  if (!req.auth?.isSuperadmin) return reply.notFound();
}
