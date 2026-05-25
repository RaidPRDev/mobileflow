import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  orgMembers,
  organizations,
  sessions,
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
import { consume, ipRateLimit, reset as resetRateLimit } from "../lib/rateLimit.js";
import { padToMinDuration } from "../lib/timing.js";
import { issueCaptcha, verifyCaptcha } from "../auth/captcha.js";
import {
  CAPTCHA_AFTER_FAILS,
  clearFailedAttempts,
  isCaptchaRequired,
  recordFailedAttempt,
} from "../auth/loginAttempts.js";
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

// Usernames: lowercase a-z, digits, underscore, hyphen. Lowercased before
// insert so the unique constraint is effectively case-insensitive without
// needing CITEXT or a functional index.
const UsernameSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-zA-Z0-9_-]+$/, "Username may only contain letters, numbers, _ and -")
  .transform((s) => s.toLowerCase());

const SignupBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  name: sanitizedName(120).optional(),
  username: UsernameSchema.optional(),
  organizationName: sanitizedName(80).optional(),
  // Signup itself is rate-limited per IP rather than gated by captcha — a
  // captcha challenge before account creation is hostile UX. If we ever see
  // sustained signup abuse, flip this to optional+required and wire the
  // same captcha flow as login.
});

const CaptchaBody = z
  .object({ captchaId: z.string().uuid(), captchaCode: z.string().min(1).max(16) })
  .partial();

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
}).merge(CaptchaBody);

// Rate-limit policies. Login / device-token endpoints get a tighter cap
// than signup because signup naturally has a captcha-free path. Numbers are
// per-IP unless otherwise noted; the captcha gate provides the per-account
// dimension. Window is in ms.
const LOGIN_IP_LIMIT = { windowMs: 60_000, max: 20 };
const LOGIN_EMAIL_LIMIT = { windowMs: 60_000, max: 10 };
const SIGNUP_IP_LIMIT = { windowMs: 60 * 60_000, max: 10 }; // 10 signups/hour/IP
const CAPTCHA_ISSUE_LIMIT = { windowMs: 60_000, max: 20 };
const DEVICE_ISSUE_LIMIT = { windowMs: 60 * 60_000, max: 30 };
// Floor for /auth/signup wall-clock time. MUST exceed p99 of the real
// (new-user) signup branch so the duplicate branch's pad-to-floor cannot
// be distinguished by timing. Argon2id at OWASP min runs ~50-150ms and
// dominates; the rest of the path (5 INSERTs + cookie writes) adds maybe
// 20-50ms. 500ms gives generous headroom for slower hardware / DB.
const SIGNUP_MIN_DURATION_MS = 500;

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
  // ---- Signup ---------------------------------------------------------
  app.post(
    "/auth/signup",
    { preHandler: ipRateLimit({ bucket: "signup:ip", ...SIGNUP_IP_LIMIT }) },
    async (req, reply) => {
      // Signup is the classic enumeration surface. We close all three side
      // channels at once:
      //   - body shape: both branches return literally `{ok: true}` — no
      //     user/org payload, no "already in use" message, no status code
      //     variation.
      //   - cookies: NO Set-Cookie on either branch. Auto-login is gone;
      //     the SPA explicitly calls /auth/login after a successful signup.
      //   - timing: both branches run argon2id (the dominant CPU cost) and
      //     pad to a 500ms floor so wall-clock time is uniform.
      const start = Date.now();
      const body = SignupBody.parse(req.body);

      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, body.email))
        .limit(1);

      if (existing.length > 0) {
        // Duplicate branch: burn the same argon2id CPU as the real path
        // and discard the result, then pad to the deadline. We deliberately
        // do NOT short-circuit on the SELECT result so an attacker can't
        // distinguish via early-return CPU profile.
        await hashPassword(body.password);
        await padToMinDuration(start, SIGNUP_MIN_DURATION_MS);
        return reply.send({ ok: true });
      }

      const passwordHash = await hashPassword(body.password);
      const [user] = await db
        .insert(users)
        .values({
          email: body.email,
          name: body.name ?? null,
          username: body.username ?? null,
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
        .values({ name: orgName, slug, ownerUserId: user.id, billingEmail: body.email })
        .returning();
      if (!org) return reply.internalServerError("org create failed");

      await db.insert(orgMembers).values({ orgId: org.id, userId: user.id, role: "owner" });
      await db.insert(subscriptions).values({ orgId: org.id, planId: "naboria", status: "active" });

      // No establishSession() — auto-login removed. The SPA must follow up
      // with POST /auth/login. The cost is one extra round trip; the gain
      // is that the signup response carries zero bits about whether the
      // email was already registered.
      await padToMinDuration(start, SIGNUP_MIN_DURATION_MS);
      return reply.send({ ok: true });
    },
  );

  // ---- Captcha --------------------------------------------------------
  // Public, rate-limited per IP. Returns an SVG image plus the id the
  // client must echo back when submitting login.
  app.get(
    "/auth/captcha",
    { preHandler: ipRateLimit({ bucket: "captcha:ip", ...CAPTCHA_ISSUE_LIMIT }) },
    async (_req, reply) => {
      const c = await issueCaptcha();
      // Return SVG as a data URL for easy <img src=...> embedding in the SPA.
      const svgB64 = Buffer.from(c.svg, "utf8").toString("base64");
      return reply.send({
        id: c.id,
        expiresAt: c.expiresAt.toISOString(),
        imageSvg: c.svg,
        imageDataUrl: `data:image/svg+xml;base64,${svgB64}`,
      });
    },
  );

  // Lightweight probe so the SPA can decide whether to prompt for captcha
  // *before* the user even hits submit. Not rate-limited beyond the global
  // CSRF/limits because it's GET with no side effects, but we accept the
  // email as a query param so it must be URL-encoded by the caller.
  app.get<{ Querystring: { email?: string } }>(
    "/auth/login/needs-captcha",
    async (req) => {
      const email = req.query.email;
      if (!email) return { required: false, threshold: CAPTCHA_AFTER_FAILS };
      return {
        required: await isCaptchaRequired(email),
        threshold: CAPTCHA_AFTER_FAILS,
      };
    },
  );

  // ---- Login ----------------------------------------------------------
  app.post("/auth/login", async (req, reply) => {
    const body = LoginBody.parse(req.body);

    // IP rate limit is the first gate — it short-circuits brute-force
    // hammering before we touch the DB. We do this manually (not as a
    // preHandler) because we want to also apply the per-email limit
    // *after* parsing, and combining preHandler + handler logic gets
    // tangled.
    const ipR = consume("login:ip", [req.ip], LOGIN_IP_LIMIT);
    if (!ipR.allowed) {
      reply.header("Retry-After", ipR.retryAfterSec.toString());
      return reply.code(429).send({ error: "TooManyRequests" });
    }
    const emailR = consume("login:email", [body.email.toLowerCase()], LOGIN_EMAIL_LIMIT);
    if (!emailR.allowed) {
      reply.header("Retry-After", emailR.retryAfterSec.toString());
      return reply.code(429).send({ error: "TooManyRequests" });
    }

    // If this email has tripped the captcha threshold, require a valid
    // captcha submission before we even check the password. This is the
    // brute-force gate: it makes credential stuffing per-account
    // unrunnable without solving an image per attempt.
    if (await isCaptchaRequired(body.email)) {
      if (!body.captchaId || !body.captchaCode) {
        return reply.code(401).send({
          error: "CaptchaRequired",
          message: "Please solve the captcha to continue.",
        });
      }
      const ok = await verifyCaptcha(body.captchaId, body.captchaCode);
      if (!ok) {
        // A failed captcha counts as a failed attempt so attackers can't
        // burn through captchas faster than the rate limiter allows.
        await recordFailedAttempt(body.email, req.ip);
        return reply.code(401).send({ error: "CaptchaRequired", message: "Captcha did not match." });
      }
    }

    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!user || !user.passwordHash) {
      await recordFailedAttempt(body.email, req.ip);
      return reply.unauthorized("Invalid credentials");
    }
    const ok = await verifyPassword(user.passwordHash, body.password);
    if (!ok) {
      await recordFailedAttempt(body.email, req.ip);
      return reply.unauthorized("Invalid credentials");
    }

    // Clean slate on success: drop attempt history and reset the per-email
    // rate limit bucket so this user isn't punished for an attacker who
    // was probing their email.
    await clearFailedAttempts(body.email);
    resetRateLimit("login:email", [body.email.toLowerCase()]);

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

  app.post(
    "/auth/devices",
    {
      preHandler: [
        ipRateLimit({ bucket: "deviceissue:ip", ...DEVICE_ISSUE_LIMIT }),
        requireUser,
      ],
    },
    async (req, reply) => {
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
        expiresAt: issued.expiresAt,
      });
    },
  );

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
        username: user.username,
        avatarUrl: user.avatarUrl,
        isSuperadmin: user.isSuperadmin,
        // Tells the SPA whether the local password gate is available. SSO-
        // only users (no passwordHash) get a slimmed-down profile UI and a
        // type-your-email confirmation for destructive actions.
        hasPassword: !!user.passwordHash,
      },
      organizations: memberships,
    };
  });

  // ---- Personal profile (self-service) --------------------------------
  // Every mutation here is password-gated so a session-hijack can't
  // silently change the user's identity or nuke their account. OAuth-only
  // users have no passwordHash and are blocked at the verify step — they
  // must set a password first (TODO: surface a "set password" flow for
  // them; today the API just 400s).
  // Avatar accepts either an http(s) URL (e.g. provider profile pic from
  // OAuth) or a base64 data URL of common raster types. SVG is excluded
  // since it can carry JavaScript. Mirrors the org icon policy.
  const AVATAR_DATA_URL_MAX = 700_000;
  const AVATAR_DATA_MIME_RE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;
  const AVATAR_HTTP_URL_MAX = 2_000;
  const AVATAR_HTTP_URL_RE = /^https?:\/\//i;
  const AvatarUrlSchema = z.string().superRefine((v, ctx) => {
    if (AVATAR_HTTP_URL_RE.test(v)) {
      if (v.length > AVATAR_HTTP_URL_MAX) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Avatar URL is too long" });
      }
      return;
    }
    if (AVATAR_DATA_MIME_RE.test(v)) {
      if (v.length > AVATAR_DATA_URL_MAX) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Avatar image is too large" });
      }
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Avatar must be an http(s) URL or a base64 data URL of type png/jpeg/gif/webp/bmp",
    });
  });

  const PatchMeBody = z.object({
    name: sanitizedName(120).nullable().optional(),
    email: z.string().email().max(254).optional(),
    username: UsernameSchema.nullable().optional(),
    avatarUrl: AvatarUrlSchema.nullable().optional(),
    // currentPassword is required for any identity change (name/email/
    // username). Avatar-only edits don't require it.
    currentPassword: z.string().max(200).optional(),
  });

  app.patch("/me", { preHandler: requireUser }, async (req, reply) => {
    if (!req.auth) return;
    const body = PatchMeBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, req.auth.userId)).limit(1);
    if (!user) return reply.unauthorized();

    const touchesIdentity =
      body.name !== undefined || body.email !== undefined || body.username !== undefined;
    if (touchesIdentity) {
      if (user.passwordHash) {
        if (!body.currentPassword) return reply.badRequest("Current password is required");
        const ok = await verifyPassword(user.passwordHash, body.currentPassword);
        if (!ok) return reply.unauthorized("Current password is incorrect");
      } else {
        // SSO-only users have no local password to gate identity changes. We
        // narrow what they can edit: username only. Name + email stay locked
        // to the SSO identity until they set a local password.
        if (body.name !== undefined || body.email !== undefined) {
          return reply.badRequest("Set a password before editing your name or email");
        }
      }
    }

    const updates: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.email !== undefined) updates.email = body.email;
    if (body.username !== undefined) updates.username = body.username;
    if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;

    try {
      await db.update(users).set(updates).where(eq(users.id, user.id));
    } catch (e: unknown) {
      // 23505 = postgres unique_violation — surfaces as "email already in
      // use" / "username already taken" without leaking which user holds it.
      const code = (e as { code?: string } | null)?.code;
      if (code === "23505") return reply.conflict("Email or username already in use");
      throw e;
    }
    return { ok: true };
  });

  const ChangePasswordBody = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200),
  });

  app.post("/me/change-password", { preHandler: requireUser }, async (req, reply) => {
    if (!req.auth) return;
    const body = ChangePasswordBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, req.auth.userId)).limit(1);
    if (!user) return reply.unauthorized();
    if (!user.passwordHash) return reply.badRequest("This account has no password set");

    const ok = await verifyPassword(user.passwordHash, body.currentPassword);
    if (!ok) return reply.unauthorized("Current password is incorrect");

    const newHash = await hashPassword(body.newPassword);
    await db.update(users).set({ passwordHash: newHash, updatedAt: new Date() }).where(eq(users.id, user.id));
    // Invalidate every other session so a stolen cookie can't outlive the
    // password change. The caller's session stays alive via cookie-bound
    // re-establishment below.
    await db.delete(sessions).where(eq(sessions.userId, user.id));
    const sess = await createSession({ userId: user.id, userAgent: req.headers["user-agent"], ip: req.ip });
    establishSession(reply, sess.id, sess.expiresAt);
    return { ok: true };
  });

  // Either a password (local-auth users) or the user's own email (SSO-only
  // users) confirms the destructive action. Both are validated server-side;
  // the SPA picks which to prompt for based on `me.user.hasPassword`.
  const DeleteMeBody = z
    .object({
      password: z.string().min(1).max(200).optional(),
      email: z.string().email().max(254).optional(),
    })
    .refine((v) => !!v.password || !!v.email, {
      message: "password or email confirmation is required",
    });

  app.post("/me/delete", { preHandler: requireUser }, async (req, reply) => {
    if (!req.auth) return;
    const body = DeleteMeBody.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, req.auth.userId)).limit(1);
    if (!user) return reply.unauthorized();

    if (user.passwordHash) {
      if (!body.password) return reply.badRequest("Password is required");
      const ok = await verifyPassword(user.passwordHash, body.password);
      if (!ok) return reply.unauthorized("Password is incorrect");
    } else {
      // SSO-only: confirm by typing the account email. Case-insensitive match
      // mirrors how email addresses are normalized for lookups.
      if (!body.email) return reply.badRequest("Email is required");
      if (body.email.trim().toLowerCase() !== user.email.toLowerCase()) {
        return reply.unauthorized("Email does not match");
      }
    }

    // Drop every org this user owns first. organizations.ownerUserId is
    // ON DELETE RESTRICT, so the user-delete would otherwise fail. Cascades
    // from organizations.id handle the rest (apps, builds, subs, members).
    const owned = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.ownerUserId, user.id));
    for (const o of owned) {
      await db.delete(organizations).where(eq(organizations.id, o.id));
    }
    // Now safe to drop the user. Cascades: sessions, deviceTokens,
    // ssoIdentities, orgMembers in remaining orgs.
    await db.delete(users).where(eq(users.id, user.id));

    reply.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: env.isProd,
      sameSite: "lax",
      path: "/",
    });
    clearCsrfCookie(reply);
    return { ok: true };
  });
}
