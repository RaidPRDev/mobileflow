import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { apps, environmentVars, environments } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { sanitizeLabel } from "../lib/sanitize.js";

const SECRET_PLACEHOLDER = "********";

// Trim happens inside the schema so the persisted value matches the
// validation surface — otherwise a caller could pad with whitespace to
// bypass a uniqueness check or the visible length.
const EnvNameSchema = z
  .string()
  .max(200)
  .transform((s) => sanitizeLabel(s).trim())
  .pipe(z.string().min(1, "Name is required").max(80, "Name must be 80 characters or fewer"));

const CreateEnv = z.object({ name: EnvNameSchema }).strict();
const PatchEnv = z.object({ name: EnvNameSchema }).strict();

// Keep this regex in sync with apps/web/src/routes/EnvironmentsPage.tsx
// (ENV_KEY_RE) so the client and server reject the same shapes. Keys are
// uppercased on the client; we still validate post-trim here so a malformed
// payload from a non-UI client gets a clean 400 instead of a DB write.
const VarBody = z.object({
  key: z
    .string()
    .trim()
    .min(1, "Key is required")
    .max(120, "Key must be 120 characters or fewer")
    .regex(/^[A-Z][A-Z0-9_]*$/, "Use SCREAMING_SNAKE_CASE"),
  value: z.string().max(8192, "Value must be 8192 characters or fewer"),
  isSecret: z.boolean().optional().default(false),
}).strict();

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
    // Prevent two environments with the same name on the same app — the DB
    // doesn't have a uniqueness constraint here so we enforce it in code.
    const [dup] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(and(eq(environments.appId, a.id), eq(environments.name, body.name)))
      .limit(1);
    if (dup) return reply.conflict("An environment with that name already exists");
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
    if (body.name !== e.name) {
      const [dup] = await db
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.appId, e.appId), eq(environments.name, body.name)))
        .limit(1);
      if (dup) return reply.conflict("An environment with that name already exists");
    }
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
    // No DB-level uniqueness on (environment_id, key); enforce here to avoid
    // shipping duplicate keys to the build runner (where the second one
    // would silently override the first).
    const [dup] = await db
      .select({ id: environmentVars.id })
      .from(environmentVars)
      .where(and(eq(environmentVars.environmentId, e.id), eq(environmentVars.key, body.key)))
      .limit(1);
    if (dup) return reply.conflict(`Variable "${body.key}" already exists in this environment`);
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
