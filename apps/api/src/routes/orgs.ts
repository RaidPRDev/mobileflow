import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { organizations } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";

const IconUrlSchema = z
  .string()
  .max(2_000_000)
  .refine(
    (v) => /^https?:\/\//i.test(v) || /^data:image\//i.test(v),
    "Icon must be a http(s) URL or a data:image/* URL",
  );

const PatchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    iconUrl: IconUrlSchema.nullable().optional(),
    description: z.string().max(500).nullable().optional(),
    billingEmail: z.string().email().max(254).nullable().optional(),
  })
  .strict();

export async function orgsRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const [row] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.params.orgId))
      .limit(1);
    if (!row) return reply.notFound();
    return row;
  });

  server.patch<{ Params: { orgId: string } }>("/orgs/:orgId", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const body = PatchBody.parse(req.body);
    if (Object.keys(body).length === 0) {
      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, req.params.orgId))
        .limit(1);
      return row;
    }
    const [updated] = await db
      .update(organizations)
      .set(body)
      .where(eq(organizations.id, req.params.orgId))
      .returning();
    if (!updated) return reply.notFound();
    return updated;
  });
}
