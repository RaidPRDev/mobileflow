import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { apps, environmentVars, environments } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { decryptString, encryptString } from "../lib/crypto.js";

const SECRET_PLACEHOLDER = "********";

const CreateEnv = z.object({ name: z.string().min(1).max(80) });
const PatchEnv = z.object({ name: z.string().min(1).max(80) }).strict();

const VarBody = z.object({
  key: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/, "Use SCREAMING_SNAKE_CASE"),
  value: z.string().max(8192),
  isSecret: z.boolean().optional().default(false),
});

async function appOrFail(appId: string) {
  const [a] = await db.select().from(apps).where(and(eq(apps.id, appId), isNull(apps.deletedAt))).limit(1);
  return a ?? null;
}

export async function environmentRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { appId: string }; Querystring: { include?: string } }>(
    "/apps/:appId/environments",
    async (req, reply) => {
      const a = await appOrFail(req.params.appId);
      if (!a) return reply.notFound();
      await requireOrgMember(req, reply, a.orgId);
      if (reply.sent) return;

      const envs = await db
        .select()
        .from(environments)
        .where(eq(environments.appId, a.id))
        .orderBy(asc(environments.createdAt));

      if (req.query.include !== "vars" || envs.length === 0) return envs;

      const envIds = envs.map((e) => e.id);
      const allVars = await db
        .select()
        .from(environmentVars)
        .where(inArray(environmentVars.environmentId, envIds));

      const byEnv = new Map<string, { id: string; key: string; isSecret: boolean; value: string }[]>();
      for (const v of allVars) {
        const list = byEnv.get(v.environmentId) ?? [];
        list.push({
          id: v.id,
          key: v.key,
          isSecret: v.isSecret,
          value: v.isSecret ? SECRET_PLACEHOLDER : decryptString(v.valueEnc),
        });
        byEnv.set(v.environmentId, list);
      }
      return envs.map((e) => ({
        ...e,
        vars: (byEnv.get(e.id) ?? []).sort((a, b) => a.key.localeCompare(b.key)),
      }));
    },
  );

  server.post<{ Params: { appId: string } }>("/apps/:appId/environments", async (req, reply) => {
    const a = await appOrFail(req.params.appId);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const body = CreateEnv.parse(req.body);
    const [created] = await db.insert(environments).values({ appId: a.id, name: body.name }).returning();
    return reply.code(201).send(created);
  });

  server.patch<{ Params: { envId: string } }>("/environments/:envId", async (req, reply) => {
    const [e] = await db.select().from(environments).where(eq(environments.id, req.params.envId)).limit(1);
    if (!e) return reply.notFound();
    const [a] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, e.appId)).limit(1);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const body = PatchEnv.parse(req.body);
    const [updated] = await db.update(environments).set(body).where(eq(environments.id, e.id)).returning();
    return updated;
  });

  server.delete<{ Params: { envId: string } }>("/environments/:envId", async (req, reply) => {
    const [e] = await db.select().from(environments).where(eq(environments.id, req.params.envId)).limit(1);
    if (!e) return reply.notFound();
    const [a] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, e.appId)).limit(1);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    await db.delete(environments).where(eq(environments.id, e.id));
    return reply.code(204).send();
  });

  // Variables — secrets are returned as a placeholder, never plaintext.
  server.get<{ Params: { envId: string } }>("/environments/:envId/vars", async (req, reply) => {
    const [e] = await db.select().from(environments).where(eq(environments.id, req.params.envId)).limit(1);
    if (!e) return reply.notFound();
    const [a] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, e.appId)).limit(1);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const rows = await db.select().from(environmentVars).where(eq(environmentVars.environmentId, e.id)).orderBy(asc(environmentVars.key));
    return rows.map((v) => ({
      id: v.id,
      key: v.key,
      isSecret: v.isSecret,
      value: v.isSecret ? SECRET_PLACEHOLDER : decryptString(v.valueEnc),
    }));
  });

  server.post<{ Params: { envId: string } }>("/environments/:envId/vars", async (req, reply) => {
    const [e] = await db.select().from(environments).where(eq(environments.id, req.params.envId)).limit(1);
    if (!e) return reply.notFound();
    const [a] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, e.appId)).limit(1);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const body = VarBody.parse(req.body);
    const [v] = await db
      .insert(environmentVars)
      .values({ environmentId: e.id, key: body.key, valueEnc: encryptString(body.value), isSecret: body.isSecret })
      .returning({ id: environmentVars.id, key: environmentVars.key, isSecret: environmentVars.isSecret });
    return reply.code(201).send({ ...v, value: body.isSecret ? SECRET_PLACEHOLDER : body.value });
  });

  server.delete<{ Params: { varId: string } }>("/env-vars/:varId", async (req, reply) => {
    const [v] = await db.select().from(environmentVars).where(eq(environmentVars.id, req.params.varId)).limit(1);
    if (!v) return reply.notFound();
    const [e] = await db.select().from(environments).where(eq(environments.id, v.environmentId)).limit(1);
    if (!e) return reply.notFound();
    const [a] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, e.appId)).limit(1);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    await db.delete(environmentVars).where(eq(environmentVars.id, v.id));
    return reply.code(204).send();
  });
}
