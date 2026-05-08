import type { FastifyInstance } from "fastify";
import { count, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  apps,
  buildHosts,
  builds,
  oauthApps,
  orgMembers,
  organizations,
  plans,
  sessions,
  subscriptions,
  users,
} from "../db/schema.js";
import { requireSuperadmin } from "../auth/middleware.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { exec, withSsh, type SshTarget } from "../worker/ssh.js";

const PlanIdEnum = z.enum(["naboria", "bohio", "yucayeque", "cacique", "unlimited"]);

export async function adminRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireSuperadmin);

  // ---------- Orgs ----------

  server.get("/admin/orgs", async () => {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        ownerUserId: organizations.ownerUserId,
        createdAt: organizations.createdAt,
        planId: subscriptions.planId,
        planStatus: subscriptions.status,
      })
      .from(organizations)
      .leftJoin(subscriptions, eq(subscriptions.orgId, organizations.id))
      .orderBy(desc(organizations.createdAt));
    return rows;
  });

  server.get<{ Params: { orgId: string } }>("/admin/orgs/:orgId", async (req, reply) => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, req.params.orgId)).limit(1);
    if (!org) return reply.notFound();
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, org.id)).limit(1);
    const members = await db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: orgMembers.role,
        isSuperadmin: users.isSuperadmin,
      })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, org.id));
    const orgApps = await db
      .select({ id: apps.id, name: apps.name, runtime: apps.runtime, gitRepoFullName: apps.gitRepoFullName, createdAt: apps.createdAt })
      .from(apps)
      .where(eq(apps.orgId, org.id));
    const recentBuilds = await db
      .select({
        id: builds.id,
        appId: builds.appId,
        status: builds.status,
        target: builds.target,
        createdAt: builds.createdAt,
        commitSha: builds.commitSha,
      })
      .from(builds)
      .innerJoin(apps, eq(apps.id, builds.appId))
      .where(eq(apps.orgId, org.id))
      .orderBy(desc(builds.createdAt))
      .limit(20);
    return { org, subscription: sub ?? null, members, apps: orgApps, recentBuilds };
  });

  server.patch<{ Params: { orgId: string } }>("/admin/orgs/:orgId/plan", async (req, reply) => {
    const body = z.object({ planId: PlanIdEnum }).parse(req.body);
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, req.params.orgId)).limit(1);
    if (!org) return reply.notFound();
    await db
      .insert(subscriptions)
      .values({ orgId: org.id, planId: body.planId, status: "active" })
      .onConflictDoUpdate({
        target: subscriptions.orgId,
        set: { planId: body.planId, status: "active" },
      });
    return { ok: true };
  });

  server.delete<{ Params: { orgId: string } }>("/admin/orgs/:orgId", async (req, reply) => {
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, req.params.orgId)).limit(1);
    if (!org) return reply.notFound();
    await db.delete(organizations).where(eq(organizations.id, org.id));
    return reply.code(204).send();
  });

  // ---------- Users ----------

  server.get("/admin/users", async () => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        isSuperadmin: users.isSuperadmin,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));
    const memberships = await db
      .select({
        userId: orgMembers.userId,
        orgId: orgMembers.orgId,
        orgName: organizations.name,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .innerJoin(organizations, eq(organizations.id, orgMembers.orgId));
    return rows.map((u) => ({
      ...u,
      memberships: memberships.filter((m) => m.userId === u.id).map(({ userId: _u, ...rest }) => rest),
    }));
  });

  server.patch<{ Params: { userId: string } }>("/admin/users/:userId", async (req, reply) => {
    const body = z.object({ isSuperadmin: z.boolean().optional(), name: z.string().min(1).max(120).optional() }).strict().parse(req.body);
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, req.params.userId)).limit(1);
    if (!u) return reply.notFound();
    await db.update(users).set(body).where(eq(users.id, u.id));
    return { ok: true };
  });

  server.post<{ Params: { userId: string } }>("/admin/users/:userId/force-logout", async (req, reply) => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, req.params.userId)).limit(1);
    if (!u) return reply.notFound();
    await db.delete(sessions).where(eq(sessions.userId, u.id));
    return { ok: true };
  });

  server.delete<{ Params: { userId: string } }>("/admin/users/:userId", async (req, reply) => {
    if (req.params.userId === req.auth!.userId) return reply.badRequest("Cannot delete yourself");
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, req.params.userId)).limit(1);
    if (!u) return reply.notFound();
    await db.delete(users).where(eq(users.id, u.id));
    return reply.code(204).send();
  });

  // ---------- Builds (cross-org) ----------

  server.get("/admin/builds", async () => {
    const rows = await db
      .select({
        id: builds.id,
        status: builds.status,
        target: builds.target,
        stackId: builds.stackId,
        commitSha: builds.commitSha,
        createdAt: builds.createdAt,
        startedAt: builds.startedAt,
        finishedAt: builds.finishedAt,
        appId: builds.appId,
        appName: apps.name,
        orgId: apps.orgId,
        orgName: organizations.name,
      })
      .from(builds)
      .innerJoin(apps, eq(apps.id, builds.appId))
      .innerJoin(organizations, eq(organizations.id, apps.orgId))
      .orderBy(desc(builds.createdAt))
      .limit(100);
    return rows;
  });

  // ---------- Plans ----------

  server.get("/admin/plans", async () => db.select().from(plans).orderBy(plans.sortOrder));

  server.patch<{ Params: { planId: string } }>("/admin/plans/:planId", async (req, reply) => {
    const PatchPlan = z
      .object({
        name: z.string().min(1).max(80),
        priceCents: z.number().int().nonnegative(),
        maxApps: z.number().int().nonnegative().nullable(),
        maxSeats: z.number().int().nonnegative().nullable(),
        maxConcurrentBuilds: z.number().int().nonnegative().nullable(),
        canBuild: z.boolean(),
        stripePriceId: z.string().nullable(),
      })
      .partial();
    const body = PatchPlan.parse(req.body);
    const planIdParsed = PlanIdEnum.safeParse(req.params.planId);
    if (!planIdParsed.success) return reply.badRequest("Unknown plan");
    if (planIdParsed.data === "unlimited") return reply.badRequest("Unlimited plan is read-only");
    const [updated] = await db
      .update(plans)
      .set(body)
      .where(eq(plans.id, planIdParsed.data))
      .returning();
    return updated ?? reply.notFound();
  });

  // ---------- Build hosts ----------

  const HostBody = z.object({
    name: z.string().min(1).max(80),
    kind: z.enum(["linux_docker", "mac"]),
    hostname: z.string().min(1).max(255),
    port: z.number().int().positive().default(22),
    sshUser: z.string().min(1).max(80),
    sshKey: z.string().min(50), // PEM body
    remoteBase: z.string().min(1),
    downloadsBase: z.string().min(1),
    downloadsBaseUrl: z.string().url(),
    toolsPath: z.string().nullable().optional(),
    capacity: z.number().int().positive().default(2),
    online: z.boolean().default(true),
  });

  server.get("/admin/hosts", async () => {
    const rows = await db.select().from(buildHosts).orderBy(buildHosts.name);
    return rows.map(({ sshKeyEnc: _k, ...rest }) => rest);
  });

  server.post("/admin/hosts", async (req, reply) => {
    const body = HostBody.parse(req.body);
    const [created] = await db
      .insert(buildHosts)
      .values({
        name: body.name,
        kind: body.kind,
        hostname: body.hostname,
        port: body.port,
        sshUser: body.sshUser,
        sshKeyEnc: encryptString(body.sshKey.replace(/\\n/g, "\n")),
        remoteBase: body.remoteBase,
        downloadsBase: body.downloadsBase,
        downloadsBaseUrl: body.downloadsBaseUrl,
        toolsPath: body.toolsPath ?? null,
        capacity: body.capacity,
        online: body.online,
      })
      .returning();
    if (!created) return reply.internalServerError();
    const { sshKeyEnc: _k, ...safe } = created;
    return reply.code(201).send(safe);
  });

  server.patch<{ Params: { id: string } }>("/admin/hosts/:id", async (req, reply) => {
    const PatchHost = HostBody.partial();
    const body = PatchHost.parse(req.body);
    const patch: Record<string, unknown> = { ...body };
    if (typeof body.sshKey === "string") {
      patch.sshKeyEnc = encryptString(body.sshKey.replace(/\\n/g, "\n"));
      delete patch.sshKey;
    }
    const [updated] = await db.update(buildHosts).set(patch).where(eq(buildHosts.id, req.params.id)).returning();
    if (!updated) return reply.notFound();
    const { sshKeyEnc: _k, ...safe } = updated;
    return safe;
  });

  server.delete<{ Params: { id: string } }>("/admin/hosts/:id", async (req, reply) => {
    const [row] = await db.select({ id: buildHosts.id }).from(buildHosts).where(eq(buildHosts.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    await db.delete(buildHosts).where(eq(buildHosts.id, row.id));
    return reply.code(204).send();
  });

  server.post<{ Params: { id: string } }>("/admin/hosts/:id/test", async (req, reply) => {
    const [row] = await db.select().from(buildHosts).where(eq(buildHosts.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    const target: SshTarget = {
      host: row.hostname,
      port: row.port,
      username: row.sshUser,
      privateKey: Buffer.from(decryptString(row.sshKeyEnc), "utf8"),
    };
    try {
      const out: string[] = [];
      const result = await withSsh(target, (ssh) =>
        exec(ssh, "uname -a && echo ok", (line) => {
          out.push(line);
        }),
      );
      return { ok: result.exitCode === 0, exitCode: result.exitCode, output: out.join("\n") };
    } catch (err) {
      return reply.code(200).send({ ok: false, error: (err as Error).message });
    }
  });

  // ---------- OAuth apps ----------

  const OAuthAppBody = z.object({
    provider: z.enum(["google", "github", "gitlab", "bitbucket"]),
    kind: z.enum(["signin", "git"]),
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(500),
    scopes: z.string().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
  });

  server.get("/admin/oauth-apps", async () => {
    const rows = await db.select().from(oauthApps).orderBy(oauthApps.provider);
    return rows.map(({ clientSecretEnc: _s, ...rest }) => rest);
  });

  server.post("/admin/oauth-apps", async (req, reply) => {
    const body = OAuthAppBody.parse(req.body);
    const [created] = await db
      .insert(oauthApps)
      .values({
        provider: body.provider,
        kind: body.kind,
        clientId: body.clientId,
        clientSecretEnc: encryptString(body.clientSecret),
        scopes: body.scopes ?? null,
        enabled: body.enabled ?? true,
      })
      .onConflictDoUpdate({
        target: [oauthApps.provider, oauthApps.kind],
        set: {
          clientId: body.clientId,
          clientSecretEnc: encryptString(body.clientSecret),
          scopes: body.scopes ?? null,
          enabled: body.enabled ?? true,
        },
      })
      .returning();
    if (!created) return reply.internalServerError();
    const { clientSecretEnc: _s, ...safe } = created;
    return reply.code(201).send(safe);
  });

  server.delete<{ Params: { id: string } }>("/admin/oauth-apps/:id", async (req, reply) => {
    const [row] = await db.select({ id: oauthApps.id }).from(oauthApps).where(eq(oauthApps.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    await db.delete(oauthApps).where(eq(oauthApps.id, row.id));
    return reply.code(204).send();
  });

  // ---------- Stats ----------

  server.get("/admin/stats", async () => {
    const [u] = await db.select({ n: count() }).from(users);
    const [o] = await db.select({ n: count() }).from(organizations);
    const [a] = await db.select({ n: count() }).from(apps).where(isNull(apps.deletedAt));
    const [b] = await db.select({ n: count() }).from(builds);
    const [running] = await db
      .select({ n: count() })
      .from(builds)
      .where(sql`status IN ('queued','running')`);
    return {
      users: u?.n ?? 0,
      organizations: o?.n ?? 0,
      apps: a?.n ?? 0,
      builds: b?.n ?? 0,
      runningOrQueued: running?.n ?? 0,
    };
  });
}
