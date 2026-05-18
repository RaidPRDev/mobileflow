import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import forge from "node-forge";
import { z } from "zod";
import { db } from "../db/client.js";
import { apps, builds, certificates } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { sanitizeLabel } from "../lib/sanitize.js";

// Limit upload size at the route level via Fastify body limit — we keep this
// modest because keystores are tiny. Increase if real provisioning bundles need it.
const MAX_BLOB_BYTES = 5 * 1024 * 1024;

// `fileName` ends up concatenated into filesystem paths on the build host
// (e.g. `${certsDir}/${cert.fileName}`). Without sanitization, an upload
// named `../../etc/something.p12` would write the blob outside the certs
// directory. Reject path separators, control characters, and leading-dot
// names (which would also rule out `.` and `..` self/parent references).
// The worker re-applies `safeBasename` on read as defense-in-depth for any
// legacy rows that pre-date this check.
const SafeFileName = z
  .string()
  .trim()
  .min(1, "fileName is required")
  .max(255, "fileName must be 255 characters or fewer")
  .refine((v) => !/[\x00-\x1f\x7f]/.test(v), "fileName must not contain control characters")
  .refine((v) => !/[\\/]/.test(v), "fileName must not contain path separators")
  .refine((v) => !v.startsWith("."), "fileName must not start with a dot");

// Label is user-typed and rendered prominently in the Certificates list +
// echoed into build logs. Strip control/bidi chars so a "trojan source"
// label can't disguise itself in the UI or log lines.
const LabelSchema = z
  .string()
  .max(400)
  .transform((s) => sanitizeLabel(s).trim())
  .pipe(z.string().min(1, "label is required").max(120, "label must be 120 characters or fewer"));

const CreateBody = z.object({
  platform: z.enum(["ios", "android"]),
  kind: z.enum(["p12", "provisioning", "keystore"]),
  label: LabelSchema,
  fileName: SafeFileName,
  fileBase64: z.string().min(1),
  password: z.string().max(2048).optional(),
  // User-supplied metadata values are short identifiers (e.g. keystore
  // `alias`). Strip control/bidi codepoints and cap length so a malicious
  // value can't hide in the UI or wreck a build log when echoed.
  metadata: z.record(z.string().max(500).transform(sanitizeLabel)).optional(),
  parentCertId: z.string().uuid().optional(),
});

const profileRowSelect = {
  id: certificates.id,
  appId: certificates.appId,
  platform: certificates.platform,
  kind: certificates.kind,
  label: certificates.label,
  fileName: certificates.fileName,
  metadata: certificates.metadata,
  createdAt: certificates.createdAt,
  parentCertId: certificates.parentCertId,
} as const;

/** Match a single <key>NAME</key><{type}>VALUE</{type}> pair anywhere in the
 * latin1-decoded plist of a CMS-signed .mobileprovision. The plist body is
 * plaintext inside the envelope so a regex over the raw bytes is sufficient. */
function plistScalar(text: string, key: string, type: "string" | "date"): string | null {
  const re = new RegExp(`<key>${key}<\\/key>\\s*<${type}>([^<]+)<\\/${type}>`);
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : null;
}

export interface ProvisionInfo {
  uuid: string;
  bundleId: string | null;     // application-identifier as stored in the plist (team-prefixed, e.g. "ABC123.com.x.y")
  teamId: string | null;
  name: string | null;
  creationDate: string | null;   // ISO
  expirationDate: string | null; // ISO
}

/** Pull UUID + identification fields out of a .mobileprovision. */
function extractProvisionInfo(buf: Buffer): ProvisionInfo | null {
  const text = buf.toString("latin1");
  const uuid = plistScalar(text, "UUID", "string");
  if (!uuid) return null;
  // application-identifier sits inside Entitlements; the regex matches the
  // first occurrence in the file which is always the entitlements block.
  const appId = text.match(/<key>application-identifier<\/key>\s*<string>([^<]+)<\/string>/);
  const bundleId = appId && appId[1] ? appId[1].trim() : null;
  // TeamIdentifier sits inside an <array>; pull the first <string> after the key.
  const teamMatch = text.match(/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
  const teamId = teamMatch && teamMatch[1] ? teamMatch[1].trim() : null;
  return {
    uuid,
    bundleId,
    teamId,
    name: plistScalar(text, "Name", "string"),
    creationDate: plistScalar(text, "CreationDate", "date"),
    expirationDate: plistScalar(text, "ExpirationDate", "date"),
  };
}

export interface P12Info {
  commonName: string | null;
  notBefore: string | null; // ISO
  notAfter: string | null;  // ISO
}

/** Parse a PKCS#12 (.p12) blob and return the leaf certificate's identity +
 * validity. Returns null if the password is wrong or the file is malformed.
 * A .p12 typically bundles the signing cert + intermediates; the leaf is the
 * one with the shortest validity window (Apple's WWDR roots have multi-decade
 * lifetimes, leaf signing certs are valid ~1 year). */
function extractP12Info(buf: Buffer, password: string): P12Info | null {
  try {
    const der = forge.util.createBuffer(buf.toString("binary"));
    const asn1 = forge.asn1.fromDer(der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
    let leaf: forge.pki.Certificate | null = null;
    for (const safeContents of p12.safeContents) {
      for (const bag of safeContents.safeBags) {
        const cert = bag.cert;
        if (!cert?.validity?.notAfter) continue;
        if (!leaf || cert.validity.notAfter < leaf.validity.notAfter) leaf = cert;
      }
    }
    if (!leaf) return null;
    const cn = leaf.subject.getField("CN") as { value?: string } | null;
    return {
      commonName: cn?.value ?? null,
      notBefore: leaf.validity.notBefore?.toISOString() ?? null,
      notAfter: leaf.validity.notAfter?.toISOString() ?? null,
    };
  } catch {
    return null;
  }
}

function mergeProvisionInfo(meta: Record<string, string>, info: ProvisionInfo) {
  meta.provisionId = info.uuid;
  if (info.bundleId) meta.bundleId = info.bundleId;
  if (info.teamId) meta.teamId = info.teamId;
  // Note: keep `provisionName` reserved for the file basename used by the
  // mac runner. The plist's display name goes in `displayName` instead.
  if (info.name) meta.displayName = info.name;
  if (info.creationDate) meta.creationDate = info.creationDate;
  if (info.expirationDate) meta.expirationDate = info.expirationDate;
}

function mergeP12Info(meta: Record<string, string>, info: P12Info) {
  if (info.commonName) meta.commonName = info.commonName;
  if (info.notBefore) meta.creationDate = info.notBefore;
  if (info.notAfter) meta.expirationDate = info.notAfter;
}

/** Walk a JKS keystore and return the earliest notAfter across every cert in
 * every key-entry chain. Returns null if the blob isn't JKS (magic mismatch)
 * or the structure is malformed. The cert chain is stored in plaintext in
 * JKS — only the private key is encrypted — so this needs no password.
 *
 * JKS layout (sun.security.provider.JavaKeyStore):
 *   magic u32         = 0xFEEDFEED
 *   version u32
 *   count u32
 *   entries[count] of {
 *     tag u32                        // 1 = PrivateKey, 2 = TrustedCert
 *     alias utf-string (u16 len)
 *     creationDate u64 (millis)
 *     if tag==1:
 *       encryptedKey   u32 len + bytes
 *       chain count u32
 *       chain[count] of { type utf-string, cert u32 len + DER }
 *     if tag==2:
 *       type utf-string, cert u32 len + DER
 *   }
 */
function extractJksExpiration(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf.readUInt32BE(0) !== 0xfeedfeed) return null;
  const count = buf.readUInt32BE(8);
  let off = 12;
  let leaf: Date | null = null;

  const readCertExpiration = (certDer: Buffer) => {
    try {
      const asn1 = forge.asn1.fromDer(forge.util.createBuffer(certDer.toString("binary")));
      const cert = forge.pki.certificateFromAsn1(asn1);
      const notAfter = cert.validity?.notAfter;
      if (notAfter && (!leaf || notAfter < leaf)) leaf = notAfter;
    } catch {
      /* skip bad certs */
    }
  };

  try {
    for (let i = 0; i < count; i++) {
      if (off + 4 > buf.length) return null;
      const tag = buf.readUInt32BE(off); off += 4;

      if (off + 2 > buf.length) return null;
      const aliasLen = buf.readUInt16BE(off); off += 2 + aliasLen;
      off += 8; // creation date u64

      if (tag === 1) {
        if (off + 4 > buf.length) return null;
        const keyLen = buf.readUInt32BE(off); off += 4 + keyLen;

        if (off + 4 > buf.length) return null;
        const chainLen = buf.readUInt32BE(off); off += 4;
        for (let j = 0; j < chainLen; j++) {
          if (off + 2 > buf.length) return null;
          const typeLen = buf.readUInt16BE(off); off += 2 + typeLen;
          if (off + 4 > buf.length) return null;
          const certLen = buf.readUInt32BE(off); off += 4;
          readCertExpiration(buf.subarray(off, off + certLen));
          off += certLen;
        }
      } else if (tag === 2) {
        if (off + 2 > buf.length) return null;
        const typeLen = buf.readUInt16BE(off); off += 2 + typeLen;
        if (off + 4 > buf.length) return null;
        const certLen = buf.readUInt32BE(off); off += 4;
        readCertExpiration(buf.subarray(off, off + certLen));
        off += certLen;
      } else {
        return null; // unknown tag → bail
      }
    }
  } catch {
    return null;
  }

  return leaf ? (leaf as Date).toISOString() : null;
}

/** Parse a keystore (.jks / .keystore / .p12) and return the leaf cert's
 * notAfter as ISO. Tries PKCS#12 first when a password is supplied (modern
 * Android Studio default), then JKS (no password needed for the cert chain). */
function extractKeystoreExpiration(buf: Buffer, password: string): string | null {
  if (password) {
    const info = extractP12Info(buf, password);
    if (info?.notAfter) return info.notAfter;
  }
  return extractJksExpiration(buf);
}

export async function certificateRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { appId: string } }>("/apps/:appId/certificates", async (req, reply) => {
    const [app] = await db
      .select({ id: apps.id, orgId: apps.orgId })
      .from(apps)
      .where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt)))
      .limit(1);
    if (!app) return reply.notFound();
    await requireOrgMember(req, reply, app.orgId);
    if (reply.sent) return;

    // Parents (p12, keystore) — top-level rows that show in the list.
    const parents = await db
      .select(profileRowSelect)
      .from(certificates)
      .where(and(eq(certificates.appId, app.id), isNull(certificates.parentCertId)))
      .orderBy(asc(certificates.createdAt));

    // Children (provisioning profiles) — fetched in a single query and grouped.
    const children = await db
      .select(profileRowSelect)
      .from(certificates)
      .where(eq(certificates.appId, app.id))
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

  server.post<{ Params: { appId: string } }>("/apps/:appId/certificates", async (req, reply) => {
    const [app] = await db
      .select({ id: apps.id, orgId: apps.orgId })
      .from(apps)
      .where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt)))
      .limit(1);
    if (!app) return reply.notFound();
    await requireOrgMember(req, reply, app.orgId);
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
    //  - provisioning profiles must reference a p12 in the same app.
    if (body.kind === "provisioning") {
      if (!body.parentCertId) return reply.badRequest("Provisioning profile requires parentCertId");
      const [parent] = await db.select().from(certificates).where(eq(certificates.id, body.parentCertId)).limit(1);
      if (!parent) return reply.badRequest("Parent certificate not found");
      if (parent.appId !== app.id) return reply.forbidden("Parent certificate belongs to a different app");
      if (parent.kind !== "p12") return reply.badRequest("Parent must be an iOS p12 certificate");
    } else if (body.parentCertId) {
      return reply.badRequest("Only provisioning profiles can have a parentCertId");
    }

    const metadata: Record<string, string> = { ...(body.metadata ?? {}) };

    // For iOS provisioning profiles, parse the .mobileprovision server-side and
    // persist the fields the UI / runner need (UUID, bundleId, team, dates).
    // Rejecting here surfaces bad uploads at the source instead of at build time.
    if (body.platform === "ios" && body.kind === "provisioning") {
      const info = extractProvisionInfo(buf);
      if (!info) return reply.badRequest("Could not read provisioning profile UUID from .mobileprovision");
      mergeProvisionInfo(metadata, info);
    }

    // For .p12s, parse the leaf cert's subject CN + validity so the UI can
    // surface expiration without re-parsing on every list. Silently skip if
    // the password is wrong or the file is unreadable — the upload still
    // succeeds and the column shows "—".
    if (body.kind === "p12" && body.password) {
      const info = extractP12Info(buf, body.password);
      if (info) mergeP12Info(metadata, info);
    }

    // For Android keystores, surface the signing cert's expiration in the
    // listing. JKS holds the cert chain in plaintext (no password required);
    // PKCS#12 keystores need the password and use the same parser as iOS.
    if (body.kind === "keystore") {
      const exp = extractKeystoreExpiration(buf, body.password ?? "");
      if (exp) metadata.expirationDate = exp;
    }

    const [created] = await db
      .insert(certificates)
      .values({
        appId: app.id,
        platform: body.platform,
        kind: body.kind,
        parentCertId: body.parentCertId ?? null,
        label: body.label,
        fileName: body.fileName,
        fileBlobEnc: encryptString(buf.toString("base64")),
        passwordEnc: body.password ? encryptString(body.password) : null,
        metadata,
      })
      .returning(profileRowSelect);
    return reply.code(201).send(created);
  });

  const PatchBody = z.object({
    label: LabelSchema.optional(),
    password: z.string().max(2048).nullable().optional(), // null = clear, undefined = keep
    // User-supplied metadata values are short identifiers (e.g. keystore
  // `alias`). Strip control/bidi codepoints and cap length so a malicious
  // value can't hide in the UI or wreck a build log when echoed.
  metadata: z.record(z.string().max(500).transform(sanitizeLabel)).optional(),
    fileName: SafeFileName.optional(),
    fileBase64: z.string().min(1).optional(),
  });

  server.patch<{ Params: { id: string } }>("/certificates/:id", async (req, reply) => {
    const [row] = await db.select().from(certificates).where(eq(certificates.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    const [app] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, row.appId)).limit(1);
    if (!app) return reply.notFound();
    await requireOrgMember(req, reply, app.orgId);
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

      // If we're replacing the file on an iOS provisioning profile, re-parse
      // the plist so metadata stays in sync with the bytes.
      if (row.platform === "ios" && row.kind === "provisioning") {
        const info = extractProvisionInfo(buf);
        if (!info) return reply.badRequest("Could not read provisioning profile UUID from .mobileprovision");
        const nextMeta: Record<string, string> = { ...(patch.metadata ?? row.metadata ?? {}) };
        mergeProvisionInfo(nextMeta, info);
        patch.metadata = nextMeta;
      }

      // If we're replacing a .p12 blob, re-parse the cert info using the
      // password supplied in this PATCH or the one already stored.
      if (row.kind === "p12") {
        const pw =
          body.password !== undefined && body.password !== null && body.password !== ""
            ? body.password
            : row.passwordEnc
            ? decryptString(row.passwordEnc)
            : "";
        const info = pw ? extractP12Info(buf, pw) : null;
        const nextMeta: Record<string, string> = { ...((patch.metadata ?? row.metadata ?? {}) as Record<string, string>) };
        // Drop any prior cert fields first so a re-upload doesn't leave stale data.
        delete nextMeta.commonName;
        delete nextMeta.creationDate;
        delete nextMeta.expirationDate;
        if (info) mergeP12Info(nextMeta, info);
        patch.metadata = nextMeta;
      }

      // If we're replacing a keystore blob, re-parse expiration.
      if (row.kind === "keystore") {
        const pw =
          body.password !== undefined && body.password !== null && body.password !== ""
            ? body.password
            : row.passwordEnc
            ? decryptString(row.passwordEnc)
            : "";
        const exp = extractKeystoreExpiration(buf, pw);
        const nextMeta: Record<string, string> = { ...((patch.metadata ?? row.metadata ?? {}) as Record<string, string>) };
        if (exp) nextMeta.expirationDate = exp;
        else delete nextMeta.expirationDate;
        patch.metadata = nextMeta;
      }
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
    const [app] = await db.select({ orgId: apps.orgId }).from(apps).where(eq(apps.id, row.appId)).limit(1);
    if (!app) return reply.notFound();
    await requireOrgMember(req, reply, app.orgId);
    if (reply.sent) return;

    // Guard against deleting a certificate that an in-flight build is about
    // to read. `builds.certificateId` has ON DELETE SET NULL so finished
    // builds keep their record (just lose the link), but a queued/running
    // build would crash with "Signing certificate not found" mid-signing.
    // Either the user retries the delete after the build finishes, or they
    // cancel the build first.
    const activeBuilds = await db
      .select({ id: builds.id })
      .from(builds)
      .where(
        and(
          eq(builds.certificateId, row.id),
          or(eq(builds.status, "queued"), eq(builds.status, "running")),
        ),
      )
      .limit(1);
    if (activeBuilds.length > 0) {
      return reply.conflict(
        "Cannot delete: this certificate is in use by a build that is queued or running. Cancel the build and try again.",
      );
    }

    // Identify children up front so we can report what's being destroyed and
    // wrap the whole cascade in a transaction — without it, a failure after
    // children-delete but before parent-delete would leave the parent with
    // no children but otherwise intact, which is confusing but not corrupting.
    // (parentCertId has no DB-level FK constraint; cascade lives in app code.)
    const children = await db
      .select({ id: certificates.id })
      .from(certificates)
      .where(eq(certificates.parentCertId, row.id));

    await db.transaction(async (tx) => {
      if (children.length > 0) {
        // Use inArray over `eq(parentCertId, row.id)` so the row count we just
        // measured matches what we delete — any racing inserts after the
        // SELECT won't be silently swept into this delete.
        await tx
          .delete(certificates)
          .where(inArray(certificates.id, children.map((c) => c.id)));
      }
      await tx.delete(certificates).where(eq(certificates.id, row.id));
    });
    // Encrypted blobs (fileBlobEnc) and password (passwordEnc) live inline on
    // the row, so removing the row removes the encrypted attachments too. No
    // external storage to garbage-collect.
    return reply.code(204).send();
  });
}
