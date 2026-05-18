import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  orgMembers,
  organizations,
  subscriptions,
  users,
} from "../db/schema.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { SESSION_COOKIE, createSession, deleteSession, getSession } from "../auth/session.js";
import { clearCsrfCookie, newCsrfToken, setCsrfCookie } from "../auth/csrf.js";
import {
  issueDeviceToken,
  listDeviceTokens,
  revokeDeviceToken,
} from "../auth/deviceToken.js";
import { requireUser } from "../auth/middleware.js";
import { sanitizeLabel } from "../lib/sanitize.js";
import { env } from "../env.js";

// Strip C0/C1 controls and bidi-override codepoints from user/org name so a
// "trojan source" display name can't sneak in at signup. Lengths match the
// downstream schemas (users.name 120, orgs.name 120).
const sanitizedName = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((s) => sanitizeLabel(s).trim())
    .pipe(z.string().min(1).max(max));

const SignupBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  name: sanitizedName(120).optional(),
  organizationName: sanitizedName(80).optional(),
});

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

function setSessionCookie(reply: import("fastify").FastifyReply, id: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, id, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    expires,
    signed: false,
  });
}

// Issue both the session and CSRF cookies in lockstep so the SPA always has
// a fresh CSRF token after any login/signup transition. Exported so the OAuth
// callback path can call the same helper.
export function establishSession(
  reply: import("fastify").FastifyReply,
  id: string,
  expires: Date,
) {
  setSessionCookie(reply, id, expires);
  setCsrfCookie(reply, newCsrfToken(), expires);
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/signup", async (req, reply) => {
    const body = SignupBody.parse(req.body);
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing.length > 0) return reply.conflict("Email already in use");

    const passwordHash = await hashPassword(body.password);
    const [user] = await db
      .insert(users)
      .values({
        email: body.email,
        name: body.name ?? null,
        passwordHash,
        isSuperadmin: env.SUPERADMIN_EMAIL === body.email,
      })
      .returning();
    if (!user) return reply.internalServerError("user create failed");

    const orgName = body.organizationName ?? body.name ?? body.email.split("@")[0]!;
    const baseSlug = slugify(orgName);
    let slug = baseSlug;
    for (let i = 1; ; i++) {
      const exists = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, slug))
        .limit(1);
      if (exists.length === 0) break;
      slug = `${baseSlug}-${i}`;
    }

    const [org] = await db
      .insert(organizations)
      .values({ name: orgName, slug, ownerUserId: user.id })
      .returning();
    if (!org) return reply.internalServerError("org create failed");

    await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
    await db.insert(subscriptions).values({ orgId: org.id, planId: "naboria", status: "active" });

    const sess = await createSession({
      userId: user.id,
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    establishSession(reply, sess.id, sess.expiresAt);
    return { user: { id: user.id, email: user.email, name: user.name }, org: { id: org.id, slug: org.slug, name: org.name } };
  });

  app.post("/auth/login", async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!user || !user.passwordHash) return reply.unauthorized("Invalid credentials");
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) return reply.unauthorized("Invalid credentials");

    const sess = await createSession({
      userId: user.id,
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });
    establishSession(reply, sess.id, sess.expiresAt);
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post("/auth/logout", async (req, reply) => {
    const id = req.cookies[SESSION_COOKIE];
    if (id) await deleteSession(id);
    reply.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: env.isProd,
      sameSite: "lax",
      path: "/",
    });
    clearCsrfCookie(reply);
    return { ok: true };
  });

  // ---- Device tokens (long-lived bearer tokens for the desktop app) ----
  //
  // Issuance is intentionally gated on a cookie session (not a bearer token).
  // This means an attacker who steals a bearer token cannot mint *more*
  // bearer tokens from it — the only way to provision a new device is to log
  // in via the web UI. The cookie-auth path also enforces CSRF, so a
  // malicious site can't trick the user's browser into silently provisioning
  // a token for the attacker.
  const DeviceIssueBody = z.object({ name: sanitizedName(120) });

  app.post("/auth/devices", { preHandler: requireUser }, async (req, reply) => {
    if (!req.auth) return; // requireUser already replied
    if (req.auth.viaBearer) return reply.forbidden("Device tokens must be created from a browser session");
    const body = DeviceIssueBody.parse(req.body);
    const issued = await issueDeviceToken({ userId: req.auth.userId, name: body.name });
    // `token` field is the only place the raw secret ever appears. The client
    // must capture it now; subsequent GET /auth/devices only returns the
    // prefix preview.
    return reply.code(201).send({
      id: issued.id,
      name: body.name,
      token: issued.token,
      tokenPrefix: issued.prefix,
      createdAt: issued.createdAt,
    });
  });

  app.get("/auth/devices", { preHandler: requireUser }, async (req) => {
    if (!req.auth) return; // requireUser already replied
    return listDeviceTokens(req.auth.userId);
  });

  app.delete<{ Params: { id: string } }>(
    "/auth/devices/:id",
    { preHandler: requireUser },
    async (req, reply) => {
      if (!req.auth) return;
      const ok = await revokeDeviceToken(req.params.id, req.auth.userId);
      if (!ok) return reply.notFound();
      return reply.code(204).send();
    },
  );

  app.get("/auth/me", async (req, reply) => {
    const id = req.cookies[SESSION_COOKIE];
    if (!id) return reply.unauthorized();
    const sess = await getSession(id);
    if (!sess) return reply.unauthorized();
    const [user] = await db.select().from(users).where(eq(users.id, sess.userId)).limit(1);
    if (!user) return reply.unauthorized();
    const memberships = await db
      .select({
        orgId: organizations.id,
        slug: organizations.slug,
        name: organizations.name,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, user.id));
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isSuperadmin: user.isSuperadmin,
      },
      organizations: memberships,
    };
  });
}
