import type { FastifyRequest, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { orgMembers, users } from "../db/schema.js";
import { SESSION_COOKIE, getSession } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: { userId: string; isSuperadmin: boolean };
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const id = req.cookies[SESSION_COOKIE];
  if (!id) return reply.unauthorized();
  const sess = await getSession(id);
  if (!sess) return reply.unauthorized();
  const [u] = await db.select({ id: users.id, isSuperadmin: users.isSuperadmin }).from(users).where(eq(users.id, sess.userId)).limit(1);
  if (!u) return reply.unauthorized();
  req.auth = { userId: u.id, isSuperadmin: u.isSuperadmin };
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
