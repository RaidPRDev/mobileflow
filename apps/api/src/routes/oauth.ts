import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { orgMembers, organizations, ssoIdentities, subscriptions, users } from "../db/schema.js";
import { OAUTH_STATE_COOKIE, authorizeRedirectUrl, exchangeCode, newState, resolveProvider } from "../auth/oauth.js";
import { createSession } from "../auth/session.js";
import { establishSession } from "./auth.js";
import { env } from "../env.js";

function redirectUriFor(providerId: "google" | "github"): string {
  return `${env.API_BASE_URL}/api/auth/oauth/${providerId}/callback`;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

async function ensureUserAndOrg(profile: { subject: string; email: string | null; name: string | null }, providerId: "google" | "github") {
  const existingId = await db
    .select({ userId: ssoIdentities.userId })
    .from(ssoIdentities)
    .where(and(eq(ssoIdentities.provider, providerId), eq(ssoIdentities.subject, profile.subject)))
    .limit(1);
  if (existingId[0]) return existingId[0].userId;

  if (!profile.email) throw new Error(`OAuth profile missing email (${providerId})`);
  const [byEmail] = await db.select().from(users).where(eq(users.email, profile.email)).limit(1);
  let userId: string;
  if (byEmail) {
    userId = byEmail.id;
  } else {
    const [created] = await db
      .insert(users)
      .values({
        email: profile.email,
        name: profile.name,
        passwordHash: null,
        isSuperadmin: env.SUPERADMIN_EMAIL === profile.email,
      })
      .returning({ id: users.id });
    if (!created) throw new Error("user create failed");
    userId = created.id;

    const orgName = profile.name ?? profile.email.split("@")[0]!;
    const baseSlug = slugify(orgName);
    let slug = baseSlug;
    for (let i = 1; ; i++) {
      const exists = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug)).limit(1);
      if (!exists[0]) break;
      slug = `${baseSlug}-${i}`;
    }
    const [org] = await db.insert(organizations).values({ name: orgName, slug, ownerUserId: userId }).returning({ id: organizations.id });
    if (!org) throw new Error("org create failed");
    await db.insert(orgMembers).values({ orgId: org.id, userId, role: "owner" });
    await db.insert(subscriptions).values({ orgId: org.id, planId: "naboria", status: "active" });
  }

  await db.insert(ssoIdentities).values({ userId, provider: providerId, subject: profile.subject, email: profile.email }).onConflictDoNothing();
  return userId;
}

export async function oauthRoutes(app: FastifyInstance) {
  app.get<{ Params: { provider: "google" | "github" } }>("/auth/oauth/:provider/start", async (req, reply) => {
    const p = await resolveProvider(req.params.provider, "signin");
    if (!p) return reply.notFound(`Provider ${req.params.provider} is not configured`);
    const state = newState();
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: env.isProd,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    const url = authorizeRedirectUrl(p, redirectUriFor(req.params.provider), state, req.params.provider === "google" ? { access_type: "online", prompt: "select_account" } : {});
    return reply.redirect(url);
  });

  app.get<{ Params: { provider: "google" | "github" }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/oauth/:provider/callback",
    async (req, reply) => {
      const p = await resolveProvider(req.params.provider, "signin");
      if (!p) return reply.notFound();
      if (req.query.error) return reply.redirect(`${env.WEB_BASE_URL}/login?oauth_error=${encodeURIComponent(req.query.error)}`);
      const stateCookie = req.cookies[OAUTH_STATE_COOKIE];
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });
      if (!req.query.code || !req.query.state || !stateCookie || req.query.state !== stateCookie) {
        return reply.badRequest("Invalid OAuth state");
      }
      try {
        const { accessToken } = await exchangeCode(p, req.query.code, redirectUriFor(req.params.provider));
        const profile = await p.fetchProfile(accessToken);
        const userId = await ensureUserAndOrg(profile, req.params.provider);
        const sess = await createSession({ userId, userAgent: req.headers["user-agent"], ip: req.ip });
        establishSession(reply, sess.id, sess.expiresAt);
        return reply.redirect(`${env.WEB_BASE_URL}/auth/callback?ok=1`);
      } catch (err) {
        app.log.error({ err }, "oauth callback failed");
        return reply.redirect(`${env.WEB_BASE_URL}/login?oauth_error=exchange_failed`);
      }
    },
  );
}
