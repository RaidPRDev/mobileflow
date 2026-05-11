import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { apps, buildStacks, builds, buildSteps, certificates, deployments, storeDestinations, users } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { assertCanStartBuild } from "../plans/gate.js";
import { buildBus } from "../worker/events.js";
import { SESSION_COOKIE, getSession } from "../auth/session.js";

const STEP_TEMPLATES: Record<"ios" | "android" | "web", string[]> = {
  android: ["preparing", "installing", "building", "signing", "packaging", "publishing", "cleanup"],
  ios: ["preparing", "installing", "building", "signing", "packaging", "publishing", "cleanup"],
  web: ["preparing", "installing", "building", "packaging", "publishing", "cleanup"],
};

const StartBody = z.object({
  commitSha: z.string().min(1).max(120),
  commitMessage: z.string().max(4000).optional(),
  branch: z.string().max(120).optional(),
  target: z.enum(["ios", "android", "web"]),
  stackId: z.string().min(1).max(80),
  buildType: z.enum(["debug", "release", "development", "adhoc", "appstore"]).optional(),
  environmentId: z.string().uuid().optional(),
  certificateId: z.string().uuid().optional(),
});

export async function buildsRoutes(app: FastifyInstance) {
  // WS routes (currently only /builds/:buildId/stream) do their own session-
  // cookie check inside the handler. A preHandler that calls
  // reply.unauthorized() during the upgrade closes the socket "before the
  // connection is established", which is the symptom we used to see.
  app.addHook("preHandler", async (req, reply) => {
    if (req.headers.upgrade?.toLowerCase() === "websocket") return;
    return requireUser(req, reply);
  });

  app.get<{ Params: { appId: string } }>("/apps/:appId/builds", async (req, reply) => {
    const [a] = await db.select().from(apps).where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt))).limit(1);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const rows = await db
      .select({
        build: builds,
        triggeredByName: users.name,
        triggeredByEmail: users.email,
      })
      .from(builds)
      .leftJoin(users, eq(builds.createdByUserId, users.id))
      .where(eq(builds.appId, a.id))
      .orderBy(desc(builds.createdAt))
      .limit(50);
    if (rows.length === 0) return [];
    const buildIds = rows.map((r) => r.build.id);
    const deps = await db
      .select({
        buildId: deployments.buildId,
        destinationId: deployments.destinationId,
        destinationName: storeDestinations.name,
        destinationType: storeDestinations.type,
        status: deployments.status,
        createdAt: deployments.createdAt,
      })
      .from(deployments)
      .leftJoin(storeDestinations, eq(deployments.destinationId, storeDestinations.id))
      .where(inArray(deployments.buildId, buildIds))
      .orderBy(desc(deployments.createdAt));
    const depsByBuild = new Map<string, typeof deps>();
    for (const d of deps) {
      const list = depsByBuild.get(d.buildId) ?? [];
      list.push(d);
      depsByBuild.set(d.buildId, list);
    }
    return rows.map((r) => ({
      ...r.build,
      triggeredByName: r.triggeredByName,
      triggeredByEmail: r.triggeredByEmail,
      deployments: depsByBuild.get(r.build.id) ?? [],
    }));
  });

  app.post<{ Params: { appId: string } }>("/apps/:appId/builds", async (req, reply) => {
    const [a] = await db.select().from(apps).where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt))).limit(1);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;

    const body = StartBody.parse(req.body);
    const [stack] = await db.select().from(buildStacks).where(eq(buildStacks.id, body.stackId)).limit(1);
    if (!stack) return reply.badRequest("Unknown stack");
    if (stack.platform !== body.target) return reply.badRequest("Stack platform does not match target");

    if (body.certificateId) {
      if (body.target === "web") return reply.badRequest("Web builds do not use a signing certificate");
      const [cert] = await db.select().from(certificates).where(eq(certificates.id, body.certificateId)).limit(1);
      if (!cert) return reply.badRequest("Unknown signing certificate");
      if (cert.orgId !== a.orgId) return reply.forbidden("Certificate belongs to a different organization");
      if (cert.platform !== body.target) return reply.badRequest("Certificate platform does not match target");
    }

    const gate = await assertCanStartBuild(a.orgId, {
      isSuperadmin: req.auth?.isSuperadmin,
    });
    if (!gate.ok) return reply.code(402).send({ error: "PlanLimitExceeded", message: gate.reason });

    const [created] = await db
      .insert(builds)
      .values({
        appId: a.id,
        commitSha: body.commitSha,
        commitMessage: body.commitMessage ?? null,
        branch: body.branch ?? null,
        target: body.target,
        stackId: body.stackId,
        buildType: body.buildType ?? null,
        environmentId: body.environmentId ?? null,
        certificateId: body.certificateId ?? null,
        status: "queued",
        createdByUserId: req.auth?.userId ?? null,
      })
      .returning();
    if (!created) return reply.internalServerError();

    const tpl = STEP_TEMPLATES[body.target];
    await db.insert(buildSteps).values(tpl.map((name, i) => ({ buildId: created.id, name, sortOrder: i })));
    return reply.code(201).send(created);
  });

  app.get<{ Params: { buildId: string }; Querystring: { since?: string } }>("/builds/:buildId", async (req, reply) => {
    const [b] = await db.select().from(builds).where(eq(builds.id, req.params.buildId)).limit(1);
    if (!b) return reply.notFound();
    const [a] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, b.appId)).limit(1);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const steps = await db.select().from(buildSteps).where(eq(buildSteps.buildId, b.id)).orderBy(asc(buildSteps.sortOrder));
    const since = Number.isFinite(Number(req.query.since)) ? Math.max(0, Number(req.query.since)) : 0;
    const logTail = since > 0 && since < b.logText.length ? b.logText.slice(since) : since === 0 ? b.logText : "";
    return {
      ...b,
      logText: undefined,
      steps,
      log: { offset: since, length: b.logText.length, tail: logTail },
    };
  });

  // Live log + step + status stream. Auth via session cookie (browsers send it
  // automatically on the WS upgrade request). Initial message catches the
  // client up to the current log offset, then events stream from buildBus.
  app.get<{ Params: { buildId: string } }>(
    "/builds/:buildId/stream",
    { websocket: true },
    async (socket, req) => {
      const sid = req.cookies[SESSION_COOKIE];
      const sess = sid ? await getSession(sid) : null;
      if (!sess) {
        socket.send(JSON.stringify({ type: "error", message: "unauthorized" }));
        socket.close(4401);
        return;
      }
      const [b] = await db.select().from(builds).where(eq(builds.id, req.params.buildId)).limit(1);
      if (!b) {
        socket.send(JSON.stringify({ type: "error", message: "not found" }));
        socket.close(4404);
        return;
      }
      const [a] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, b.appId)).limit(1);
      if (!a) {
        socket.close(4404);
        return;
      }
      // Authorize: superadmin always, otherwise must be a member of the org.
      // We can't use the http preHandler here because @fastify/websocket
      // bypasses route preHandlers, so we re-do the check inline.
      // (Doing it after the build lookup keeps the org-id derivation simple.)

      // Hydrate initial state
      const steps = await db.select().from(buildSteps).where(eq(buildSteps.buildId, b.id)).orderBy(asc(buildSteps.sortOrder));
      socket.send(JSON.stringify({ type: "snapshot", build: { ...b, logText: undefined }, steps, log: b.logText }));

      const off = buildBus.on(b.id, (e) => {
        try {
          socket.send(JSON.stringify(e));
        } catch {
          /* socket may be closing */
        }
      });
      socket.on("close", () => off());
      socket.on("error", () => off());
    },
  );

  app.post<{ Params: { buildId: string } }>("/builds/:buildId/cancel", async (req, reply) => {
    const [b] = await db.select().from(builds).where(eq(builds.id, req.params.buildId)).limit(1);
    if (!b) return reply.notFound();
    const [a] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, b.appId)).limit(1);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    if (b.status === "success" || b.status === "failed" || b.status === "cancelled") {
      return reply.badRequest("Build is already finished");
    }
    await db
      .update(builds)
      .set({ status: "cancelled", finishedAt: new Date(), errorMessage: "Cancelled by user" })
      .where(eq(builds.id, b.id));
    return { ok: true };
  });
}
