import type { FastifyInstance } from "fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
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
  parentCertId: z.string().uuid().optional(),
});

const profileRowSelect = {
  id: certificates.id,
  platform: certificates.platform,
  kind: certificates.kind,
  label: certificates.label,
  fileName: certificates.fileName,
  metadata: certificates.metadata,
  createdAt: certificates.createdAt,
  parentCertId: certificates.parentCertId,
} as const;

export async function certificateRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId/certificates", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;

    // Parents (p12, keystore) — top-level rows that show in the list.
    const parents = await db
      .select(profileRowSelect)
      .from(certificates)
      .where(and(eq(certificates.orgId, req.params.orgId), isNull(certificates.parentCertId)))
      .orderBy(asc(certificates.createdAt));

    // Children (provisioning profiles) — fetched in a single query and grouped.
    const children = await db
      .select(profileRowSelect)
      .from(certificates)
      .where(eq(certificates.orgId, req.params.orgId))
      .orderBy(asc(certificates.createdAt));

    const childrenByParent = new Map<string, typeof children>();
    for (const c of children) {
      if (!c.parentCertId) continue;
      const list = childrenByParent.get(c.parentCertId) ?? [];
      list.push(c);
      childrenByParent.set(c.parentCertId, list);
    }

    return parents.map((p) => ({
      ...p,
      provisioningProfiles: childrenByParent.get(p.id) ?? [],
    }));
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
    if (body.platform === "android" && body.kind === "keystore" && !body.metadata?.alias?.trim()) {
      return reply.badRequest("Android keystore requires metadata.alias");
    }

    // Parent/child relationship rules:
    //  - p12 and keystore are top-level (must not have parentCertId).
    //  - provisioning profiles must reference a p12 in the same org.
    if (body.kind === "provisioning") {
      if (!body.parentCertId) return reply.badRequest("Provisioning profile requires parentCertId");
      const [parent] = await db.select().from(certificates).where(eq(certificates.id, body.parentCertId)).limit(1);
      if (!parent) return reply.badRequest("Parent certificate not found");
      if (parent.orgId !== req.params.orgId) return reply.forbidden("Parent certificate is in a different org");
      if (parent.kind !== "p12") return reply.badRequest("Parent must be an iOS p12 certificate");
    } else if (body.parentCertId) {
      return reply.badRequest("Only provisioning profiles can have a parentCertId");
    }

    const [created] = await db
      .insert(certificates)
      .values({
        orgId: req.params.orgId,
        platform: body.platform,
        kind: body.kind,
        parentCertId: body.parentCertId ?? null,
        label: body.label,
        fileName: body.fileName,
        fileBlobEnc: encryptString(buf.toString("base64")),
        passwordEnc: body.password ? encryptString(body.password) : null,
        metadata: body.metadata ?? {},
      })
      .returning(profileRowSelect);
    return reply.code(201).send(created);
  });

  const PatchBody = z.object({
    label: z.string().min(1).max(120).optional(),
    password: z.string().max(2048).nullable().optional(), // null = clear, undefined = keep
    metadata: z.record(z.string()).optional(),
    fileName: z.string().min(1).max(255).optional(),
    fileBase64: z.string().min(1).optional(),
  });

  server.patch<{ Params: { id: string } }>("/certificates/:id", async (req, reply) => {
    const [row] = await db.select().from(certificates).where(eq(certificates.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    await requireOrgMember(req, reply, row.orgId);
    if (reply.sent) return;
    const body = PatchBody.parse(req.body);

    // fileName and fileBase64 must come together (replacing the blob requires the new name too).
    if (body.fileBase64 !== undefined && body.fileName === undefined) {
      return reply.badRequest("fileName is required when replacing fileBase64");
    }

    const patch: Partial<typeof certificates.$inferInsert> = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.password !== undefined) {
      patch.passwordEnc = body.password === null || body.password === "" ? null : encryptString(body.password);
    }
    if (body.metadata !== undefined) patch.metadata = body.metadata;
    if (body.fileBase64 !== undefined && body.fileName !== undefined) {
      const buf = Buffer.from(body.fileBase64, "base64");
      if (buf.length === 0) return reply.badRequest("Empty file");
      if (buf.length > MAX_BLOB_BYTES) return reply.payloadTooLarge(`File exceeds ${MAX_BLOB_BYTES} bytes`);
      patch.fileBlobEnc = encryptString(buf.toString("base64"));
      patch.fileName = body.fileName;
    }
    if (Object.keys(patch).length === 0) return reply.badRequest("No fields to update");

    const [updated] = await db
      .update(certificates)
      .set(patch)
      .where(eq(certificates.id, row.id))
      .returning(profileRowSelect);
    return updated;
  });

  server.delete<{ Params: { id: string } }>("/certificates/:id", async (req, reply) => {
    const [row] = await db.select().from(certificates).where(eq(certificates.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    await requireOrgMember(req, reply, row.orgId);
    if (reply.sent) return;
    // Cascade: drop children first (the DB-level FK was omitted to keep the
    // self-reference clean in Drizzle; we handle it here instead).
    await db.delete(certificates).where(eq(certificates.parentCertId, row.id));
    await db.delete(certificates).where(eq(certificates.id, row.id));
    return reply.code(204).send();
  });
}
