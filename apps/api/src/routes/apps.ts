import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { RuntimeSchema } from "@mobileflow/shared";
import { db } from "../db/client.js";
import { apps, gitConnections, orgMembers, organizations } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { assertCanCreateApp } from "../plans/gate.js";

const CreateBody = z.object({
  name: z.string().min(1).max(80),
  runtime: RuntimeSchema,
  gitConnectionId: z.string().uuid().nullish(),
  gitRepoFullName: z.string().min(1).max(200).nullish(),
});

const IconUrlSchema = z
  .string()
  .max(2_000_000)
  .refine(
    (v) => /^https?:\/\//i.test(v) || /^data:image\//i.test(v),
    "Icon must be a http(s) URL or a data:image/* URL",
  );

const PatchBody = z
  .object({
    name: z.string().min(1).max(80).optional(),
    iconUrl: IconUrlSchema.nullable().optional(),
    runtime: RuntimeSchema.optional(),
    gitConnectionId: z.string().uuid().nullable().optional(),
    gitRepoFullName: z.string().min(1).max(200).nullable().optional(),
    gitDefaultBranch: z.string().min(1).max(120).nullable().optional(),
  })
  .strict();

const TransferBody = z.object({
  targetOrgId: z.string().uuid(),
});

function shortId(): string {
  // 8-char hex (matches the spec's c7dbbb0e style).
  return randomBytes(4).toString("hex");
}

export async function appsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireUser);

  app.get<{ Params: { orgId: string } }>("/orgs/:orgId/apps", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const rows = await db
      .select()
      .from(apps)
      .where(and(eq(apps.orgId, req.params.orgId), isNull(apps.deletedAt)))
      .orderBy(asc(apps.createdAt));
    return rows;
  });

  app.post<{ Params: { orgId: string } }>("/orgs/:orgId/apps", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const body = CreateBody.parse(req.body);
    const gate = await assertCanCreateApp(req.params.orgId, {
      isSuperadmin: req.auth?.isSuperadmin,
    });
    if (!gate.ok) return reply.code(402).send({ error: "PlanLimitExceeded", message: gate.reason });

    if (body.gitConnectionId) {
      const [conn] = await db.select({ id: gitConnections.id }).from(gitConnections)
        .where(and(eq(gitConnections.id, body.gitConnectionId), eq(gitConnections.orgId, req.params.orgId))).limit(1);
      if (!conn) return reply.badRequest("Invalid gitConnectionId");
    }

    let id = shortId();
    for (let i = 0; i < 5; i++) {
      const exists = await db.select({ id: apps.id }).from(apps).where(eq(apps.id, id)).limit(1);
      if (!exists[0]) break;
      id = shortId();
    }

    const [created] = await db
      .insert(apps)
      .values({
        id,
        orgId: req.params.orgId,
        name: body.name,
        runtime: body.runtime,
        gitConnectionId: body.gitConnectionId ?? null,
        gitRepoFullName: body.gitRepoFullName ?? null,
      })
      .returning();
    return reply.code(201).send(created);
  });

  app.get<{ Params: { appId: string } }>("/apps/:appId", async (req, reply) => {
    const [row] = await db.select().from(apps).where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt))).limit(1);
    if (!row) return reply.notFound();
    await requireOrgMember(req, reply, row.orgId);
    if (reply.sent) return;
    return row;
  });

  app.patch<{ Params: { appId: string } }>("/apps/:appId", async (req, reply) => {
    const [row] = await db.select().from(apps).where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt))).limit(1);
    if (!row) return reply.notFound();
    await requireOrgMember(req, reply, row.orgId);
    if (reply.sent) return;
    const body = PatchBody.parse(req.body);
    const [updated] = await db.update(apps).set(body).where(eq(apps.id, req.params.appId)).returning();
    return updated;
  });

  app.post<{ Params: { appId: string } }>("/apps/:appId/transfer", async (req, reply) => {
    const [row] = await db.select().from(apps).where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt))).limit(1);
    if (!row) return reply.notFound();
    await requireOrgMember(req, reply, row.orgId);
    if (reply.sent) return;
    const body = TransferBody.parse(req.body);
    if (body.targetOrgId === row.orgId) return reply.badRequest("App is already in that organization");

    const [targetOrg] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, body.targetOrgId))
      .limit(1);
    if (!targetOrg) return reply.badRequest("Target organization not found");

    if (!req.auth?.isSuperadmin) {
      const [sourceMember] = await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, row.orgId), eq(orgMembers.userId, req.auth!.userId)))
        .limit(1);
      if (!sourceMember || sourceMember.role !== "owner") {
        return reply.forbidden("Only owners can transfer apps");
      }
    }

    const gate = await assertCanCreateApp(body.targetOrgId, {
      isSuperadmin: req.auth?.isSuperadmin,
    });
    if (!gate.ok) return reply.code(402).send({ error: "PlanLimitExceeded", message: gate.reason });

    if (req.auth?.userId) {
      await db
        .insert(orgMembers)
        .values({ orgId: row.orgId, userId: req.auth.userId, role: "member" })
        .onConflictDoNothing();
    }

    const [updated] = await db
      .update(apps)
      .set({ orgId: body.targetOrgId, gitConnectionId: null })
      .where(eq(apps.id, req.params.appId))
      .returning();
    return updated;
  });

  app.delete<{ Params: { appId: string } }>("/apps/:appId", async (req, reply) => {
    const [row] = await db.select().from(apps).where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt))).limit(1);
    if (!row) return reply.notFound();
    await requireOrgMember(req, reply, row.orgId);
    if (reply.sent) return;
    await db.update(apps).set({ deletedAt: new Date() }).where(eq(apps.id, req.params.appId));
    return reply.code(204).send();
  });
}
