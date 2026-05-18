import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { RuntimeSchema } from "@mobileflow/shared";
import { db } from "../db/client.js";
import { apps, gitConnections, orgMembers, organizations } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { sanitizeLabel } from "../lib/sanitize.js";
import { assertCanCreateApp } from "../plans/gate.js";

// Name: trimmed, 1–80 chars. Trim is enforced in the schema (not just the
// handler) so the stored value matches what validation accepted — otherwise
// a caller could pad with whitespace to bypass uniqueness or length intent.
const AppNameSchema = z
  .string()
  .max(200) // pre-trim hard cap to bound parse work on hostile input
  .transform((s) => sanitizeLabel(s).trim())
  .pipe(z.string().min(1, "App name is required").max(80, "App name must be 80 characters or fewer"));

// Restrict data-URL icons to common raster MIME types. SVGs are deliberately
// excluded because they can embed JavaScript and become an XSS vector when
// rendered in <img> from an attacker-controlled data URL. The size cap (~700KB
// after base64 inflation = ~512KB raw) matches what the UI can produce from
// its 256px canvas pipeline with comfortable headroom.
const ICON_DATA_URL_MAX = 700_000;
const ICON_DATA_MIME_RE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;
const ICON_HTTP_URL_MAX = 2_000;
const ICON_HTTP_URL_RE = /^https?:\/\//i;

const IconUrlSchema = z
  .string()
  .superRefine((v, ctx) => {
    if (ICON_HTTP_URL_RE.test(v)) {
      if (v.length > ICON_HTTP_URL_MAX) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Icon URL is too long" });
      }
      return;
    }
    if (ICON_DATA_MIME_RE.test(v)) {
      if (v.length > ICON_DATA_URL_MAX) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Icon image is too large" });
      }
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Icon must be an http(s) URL or a base64 data URL of type png/jpeg/gif/webp/bmp",
    });
  });

const CreateBody = z.object({
  name: AppNameSchema,
  runtime: RuntimeSchema,
  gitConnectionId: z.string().uuid().nullish(),
  gitRepoFullName: z.string().transform((s) => sanitizeLabel(s).trim()).pipe(z.string().min(1).max(200)).nullish(),
  gitDefaultBranch: z.string().transform((s) => sanitizeLabel(s).trim()).pipe(z.string().min(1).max(120)).nullish(),
});

const PatchBody = z
  .object({
    name: AppNameSchema.optional(),
    iconUrl: IconUrlSchema.nullable().optional(),
    runtime: RuntimeSchema.optional(),
    gitConnectionId: z.string().uuid().nullable().optional(),
    gitRepoFullName: z.string().transform((s) => sanitizeLabel(s).trim()).pipe(z.string().min(1).max(200)).nullable().optional(),
    gitDefaultBranch: z.string().transform((s) => sanitizeLabel(s).trim()).pipe(z.string().min(1).max(120)).nullable().optional(),
  })
  .strict();

const TransferBody = z.object({
  targetOrgId: z.string().uuid("targetOrgId must be a UUID"),
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
        gitDefaultBranch: body.gitDefaultBranch ?? null,
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
    if (Object.keys(body).length === 0) return reply.badRequest("No fields to update");
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
