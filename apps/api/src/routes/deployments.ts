import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { apps, builds, deployments, storeDestinations } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { encryptString } from "../lib/crypto.js";

// Going forward only "app_store" and "play_store" are accepted on creation.
// (Legacy "testflight" / "play_internal" values may still exist in the enum
// for any old rows but the create UI consolidates them under these two.)
const StoreType = z.enum(["app_store", "play_store"]);

const StoreBody = z.object({
  name: z.string().min(1).max(80),
  type: StoreType,
  bundleId: z.string().min(1).max(200).nullable().optional(),
  trackOrChannel: z.string().max(80).nullable().optional(),
  config: z.record(z.unknown()),
});

async function appOrFail(appId: string) {
  const [a] = await db.select().from(apps).where(and(eq(apps.id, appId), isNull(apps.deletedAt))).limit(1);
  return a ?? null;
}

export async function deploymentRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  // ---------- Store destinations ----------

  server.get<{ Params: { appId: string } }>("/apps/:appId/destinations", async (req, reply) => {
    const a = await appOrFail(req.params.appId);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const rows = await db
      .select({
        id: storeDestinations.id,
        appId: storeDestinations.appId,
        name: storeDestinations.name,
        type: storeDestinations.type,
        bundleId: storeDestinations.bundleId,
        trackOrChannel: storeDestinations.trackOrChannel,
        createdAt: storeDestinations.createdAt,
      })
      .from(storeDestinations)
      .where(eq(storeDestinations.appId, a.id))
      .orderBy(asc(storeDestinations.createdAt));
    return rows;
  });

  server.post<{ Params: { appId: string } }>("/apps/:appId/destinations", async (req, reply) => {
    const a = await appOrFail(req.params.appId);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const body = StoreBody.parse(req.body);
    const [created] = await db
      .insert(storeDestinations)
      .values({
        appId: a.id,
        name: body.name,
        type: body.type,
        bundleId: body.bundleId ?? null,
        trackOrChannel: body.trackOrChannel ?? null,
        configEnc: encryptString(JSON.stringify(body.config)),
      })
      .returning({
        id: storeDestinations.id,
        name: storeDestinations.name,
        type: storeDestinations.type,
        bundleId: storeDestinations.bundleId,
        trackOrChannel: storeDestinations.trackOrChannel,
        createdAt: storeDestinations.createdAt,
      });
    return reply.code(201).send(created);
  });

  server.delete<{ Params: { id: string } }>("/destinations/:id", async (req, reply) => {
    const [d] = await db.select().from(storeDestinations).where(eq(storeDestinations.id, req.params.id)).limit(1);
    if (!d) return reply.notFound();
    const a = await appOrFail(d.appId);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    await db.delete(storeDestinations).where(eq(storeDestinations.id, d.id));
    return reply.code(204).send();
  });

  // ---------- Deployments ----------

  server.get<{ Params: { appId: string } }>("/apps/:appId/deployments", async (req, reply) => {
    const a = await appOrFail(req.params.appId);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const rows = await db
      .select({
        id: deployments.id,
        buildId: deployments.buildId,
        destinationId: deployments.destinationId,
        destinationName: storeDestinations.name,
        destinationType: storeDestinations.type,
        status: deployments.status,
        errorMessage: deployments.errorMessage,
        createdAt: deployments.createdAt,
        startedAt: deployments.startedAt,
        finishedAt: deployments.finishedAt,
      })
      .from(deployments)
      .innerJoin(storeDestinations, eq(storeDestinations.id, deployments.destinationId))
      .innerJoin(builds, eq(builds.id, deployments.buildId))
      .where(eq(builds.appId, a.id))
      .orderBy(desc(deployments.createdAt))
      .limit(50);
    return rows;
  });

  server.post<{ Params: { appId: string } }>("/apps/:appId/deployments", async (req, reply) => {
    const a = await appOrFail(req.params.appId);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const body = z.object({ buildId: z.string().uuid(), destinationId: z.string().uuid() }).parse(req.body);
    const [b] = await db.select().from(builds).where(and(eq(builds.id, body.buildId), eq(builds.appId, a.id))).limit(1);
    if (!b) return reply.badRequest("Build not in this app");
    if (b.status !== "success") return reply.badRequest("Only successful builds can be deployed");
    const [dest] = await db.select().from(storeDestinations).where(and(eq(storeDestinations.id, body.destinationId), eq(storeDestinations.appId, a.id))).limit(1);
    if (!dest) return reply.badRequest("Destination not in this app");

    const [created] = await db
      .insert(deployments)
      .values({
        buildId: b.id,
        destinationId: dest.id,
        status: "queued",
        createdByUserId: req.auth?.userId ?? null,
      })
      .returning();
    return reply.code(201).send(created);
  });

  server.get<{ Params: { id: string } }>("/deployments/:id", async (req, reply) => {
    const [d] = await db.select().from(deployments).where(eq(deployments.id, req.params.id)).limit(1);
    if (!d) return reply.notFound();
    const [b] = await db.select({ appId: builds.appId }).from(builds).where(eq(builds.id, d.buildId)).limit(1);
    if (!b) return reply.notFound();
    const a = await appOrFail(b.appId);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    return d;
  });
}
