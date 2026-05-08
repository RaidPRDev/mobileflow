import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { certificates } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { encryptString } from "../lib/crypto.js";

// Limit upload size at the route level via Fastify body limit — we keep this
// modest because keystores are tiny. Increase if real provisioning bundles need it.
const MAX_BLOB_BYTES = 5 * 1024 * 1024;

const CreateBody = z.object({
  platform: z.enum(["ios", "android"]),
  kind: z.enum(["p12", "provisioning", "keystore"]),
  label: z.string().min(1).max(120),
  fileName: z.string().min(1).max(255),
  fileBase64: z.string().min(1),
  password: z.string().max(2048).optional(),
  metadata: z.record(z.string()).optional(),
});

export async function certificateRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId/certificates", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const rows = await db
      .select({
        id: certificates.id,
        platform: certificates.platform,
        kind: certificates.kind,
        label: certificates.label,
        fileName: certificates.fileName,
        metadata: certificates.metadata,
        createdAt: certificates.createdAt,
      })
      .from(certificates)
      .where(eq(certificates.orgId, req.params.orgId))
      .orderBy(asc(certificates.createdAt));
    return rows;
  });

  server.post<{ Params: { orgId: string } }>("/orgs/:orgId/certificates", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const body = CreateBody.parse(req.body);
    const buf = Buffer.from(body.fileBase64, "base64");
    if (buf.length === 0) return reply.badRequest("Empty file");
    if (buf.length > MAX_BLOB_BYTES) return reply.payloadTooLarge(`File exceeds ${MAX_BLOB_BYTES} bytes`);

    if (body.platform === "android" && body.kind !== "keystore") return reply.badRequest("Android certs must be keystore");
    if (body.platform === "ios" && body.kind === "keystore") return reply.badRequest("iOS certs must be p12 or provisioning");

    const [created] = await db
      .insert(certificates)
      .values({
        orgId: req.params.orgId,
        platform: body.platform,
        kind: body.kind,
        label: body.label,
        fileName: body.fileName,
        fileBlobEnc: encryptString(buf.toString("base64")),
        passwordEnc: body.password ? encryptString(body.password) : null,
        metadata: body.metadata ?? {},
      })
      .returning({
        id: certificates.id,
        platform: certificates.platform,
        kind: certificates.kind,
        label: certificates.label,
        fileName: certificates.fileName,
        metadata: certificates.metadata,
        createdAt: certificates.createdAt,
      });
    return reply.code(201).send(created);
  });

  server.delete<{ Params: { id: string } }>("/certificates/:id", async (req, reply) => {
    const [row] = await db.select().from(certificates).where(eq(certificates.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    await requireOrgMember(req, reply, row.orgId);
    if (reply.sent) return;
    await db.delete(certificates).where(eq(certificates.id, row.id));
    return reply.code(204).send();
  });
}
