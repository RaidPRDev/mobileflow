import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { apps, builds, deployments, storeDestinations, users } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { sanitizeLabel } from "../lib/sanitize.js";

// Going forward only "app_store" and "play_store" are accepted on creation.
// (Legacy "testflight" / "play_internal" values may still exist in the enum
// for any old rows but the create UI consolidates them under these two.)
const StoreType = z.enum(["app_store", "play_store"]);

// Patterns mirror the client-side validators in StoreDestinationDialog.tsx —
// both sides enforce the same shape so an attacker bypassing the UI can't
// smuggle malformed credentials past the API. Update both sides together.
const APP_APPLE_ID_RE = /^\d{1,20}$/;
const APP_SPECIFIC_PASSWORD_RE = /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/;
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const KEY_ID_RE = /^[A-Z0-9]{10}$/;
const ISSUER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
// Cap individual credential strings well below the 1MB body limit Fastify
// allows so a malformed payload can't blow up the encryption step or the
// database column. .p8 and service-account JSON get larger ceilings because
// the legitimate values can run a few KB.
const SHORT = 200;
const MEDIUM = 1_000;
const LARGE = 16_000;

// `.or(z.literal(""))` is used for secret fields so PATCH callers can send an
// empty string meaning "keep the existing value" — the mergeConfig step below
// drops empty secrets before persisting. POST callers fail validation later
// in `assertNoEmptySecrets` because an empty secret on create would persist
// blank credentials.
const AppleAltoolConfig = z.object({
  authMode: z.literal("altool"),
  appleId: z.string().trim().min(1).max(SHORT).email(),
  appSpecificPassword: z.string().regex(APP_SPECIFIC_PASSWORD_RE).or(z.literal("")),
  appAppleId: z.string().trim().regex(APP_APPLE_ID_RE),
  teamId: z.string().trim().regex(TEAM_ID_RE),
}).strict();

const AppleApiKeyConfig = z.object({
  authMode: z.literal("api_key"),
  issuerId: z.string().trim().regex(ISSUER_ID_RE),
  keyId: z.string().trim().regex(KEY_ID_RE),
  privateKeyP8: z
    .string()
    .max(LARGE)
    .refine((v) => v === "" || v.includes("BEGIN PRIVATE KEY"), {
      message: "Private key must be a valid PEM-formatted .p8",
    }),
}).strict();

const AppStoreConfig = z.discriminatedUnion("authMode", [AppleAltoolConfig, AppleApiKeyConfig]);

const PlayStoreConfig = z.object({
  artifactKind: z.enum(["aab", "apk"]),
  serviceAccountJson: z
    .string()
    .max(LARGE)
    .refine((v) => {
      if (v === "") return true;
      try {
        const parsed = JSON.parse(v);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
      } catch {
        return false;
      }
    }, { message: "serviceAccountJson must be valid JSON" })
    .optional(),
}).strict();

function parseConfig(type: z.infer<typeof StoreType>, raw: unknown) {
  if (type === "app_store") return AppStoreConfig.parse(raw);
  return PlayStoreConfig.parse(raw);
}

// On create, secrets must be present (mergeConfig only "keeps" what's already
// stored). Reject empty secret strings to avoid persisting blank credentials
// that would silently fail later in the deploy runner.
function assertNoEmptySecrets(type: z.infer<typeof StoreType>, cfg: Record<string, unknown>) {
  if (type === "app_store") {
    if (cfg.authMode === "altool" && !cfg.appSpecificPassword) {
      throw new z.ZodError([{ code: "custom", path: ["config", "appSpecificPassword"], message: "Required" }]);
    }
    if (cfg.authMode === "api_key" && !cfg.privateKeyP8) {
      throw new z.ZodError([{ code: "custom", path: ["config", "privateKeyP8"], message: "Required" }]);
    }
  } else if (type === "play_store") {
    if (!cfg.serviceAccountJson) {
      throw new z.ZodError([{ code: "custom", path: ["config", "serviceAccountJson"], message: "Required" }]);
    }
  }
}

// Short label-style fields go through sanitizeLabel to strip C0/C1 controls
// and bidi-override codepoints — name appears in the destinations list and
// build logs, bundleId is echoed into deploy command lines.
const StoreNameSchema = z
  .string()
  .max(400)
  .transform((s) => sanitizeLabel(s).trim())
  .pipe(z.string().min(1).max(80));

const StoreBundleIdSchema = z
  .string()
  .max(400)
  .transform((s) => sanitizeLabel(s).trim())
  .pipe(z.string().min(1).max(SHORT));

const StoreBody = z.object({
  name: StoreNameSchema,
  type: StoreType,
  bundleId: StoreBundleIdSchema.nullable().optional(),
  trackOrChannel: z.enum(["internal", "alpha", "beta", "production"]).nullable().optional(),
  config: z.record(z.unknown()).refine((v) => Object.keys(v).length <= 20, "config too large"),
}).strict();

// PATCH variant: every top-level field is optional, but if `config` is sent we
// still validate it the same way. `type` isn't editable so we don't accept it.
const StorePatchBody = z.object({
  name: StoreNameSchema.optional(),
  bundleId: StoreBundleIdSchema.nullable().optional(),
  trackOrChannel: z.enum(["internal", "alpha", "beta", "production"]).nullable().optional(),
  config: z.record(z.unknown()).refine((v) => Object.keys(v).length <= 20, "config too large").optional(),
}).strict();

async function appOrFail(appId: string) {
  const [a] = await db.select().from(apps).where(and(eq(apps.id, appId), isNull(apps.deletedAt))).limit(1);
  return a ?? null;
}

// Non-secret fields exposed back to the client for prefilling the edit form.
// Secrets (appSpecificPassword, privateKeyP8, serviceAccountJson) are never
// returned — the UI prompts the user to re-enter them only when changing.
export type DestinationConfigSummary =
  | { authMode: "altool"; appleId: string; appAppleId: string; teamId: string }
  | { authMode: "api_key"; issuerId: string; keyId: string }
  | { artifactKind: "aab" | "apk" }
  | Record<string, never>;

function summarizeConfig(type: string, configEnc: string): DestinationConfigSummary {
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(decryptString(configEnc)) as Record<string, unknown>; } catch { return {}; }
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (type === "app_store") {
    const mode = s(cfg.authMode) || (cfg.privateKeyP8 || cfg.keyId || cfg.issuerId ? "api_key" : "altool");
    if (mode === "api_key") return { authMode: "api_key", issuerId: s(cfg.issuerId), keyId: s(cfg.keyId) };
    return { authMode: "altool", appleId: s(cfg.appleId), appAppleId: s(cfg.appAppleId), teamId: s(cfg.teamId) };
  }
  if (type === "play_store") {
    const kind = s(cfg.artifactKind);
    return { artifactKind: kind === "apk" ? "apk" : "aab" };
  }
  return {};
}

// Merge a partial config patch onto the existing config. Keys we recognise as
// secrets are preserved when the caller sends an empty string (so an unchanged
// edit form, where secret fields render blank, doesn't wipe the credentials).
const SECRET_KEYS = new Set(["appSpecificPassword", "privateKeyP8", "serviceAccountJson"]);

function mergeConfig(
  type: string,
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  // App Store auth mode switch (altool ↔ api_key) replaces wholesale —
  // merging would leave stale keys (e.g. old privateKeyP8) in the config,
  // and the inactive mode's secret isn't preserved anyway. The UI's
  // canSubmit check forces the user to enter the new secret in this case.
  if (type === "app_store") {
    const oldMode =
      (typeof existing.authMode === "string" && existing.authMode) ||
      (existing.privateKeyP8 || existing.keyId || existing.issuerId ? "api_key" : "altool");
    const newMode = typeof patch.authMode === "string" ? patch.authMode : oldMode;
    if (newMode !== oldMode) return { ...patch };
  }
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (SECRET_KEYS.has(k) && (v === "" || v == null)) continue;
    out[k] = v;
  }
  return out;
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
        configEnc: storeDestinations.configEnc,
      })
      .from(storeDestinations)
      .where(eq(storeDestinations.appId, a.id))
      .orderBy(asc(storeDestinations.createdAt));
    return rows.map(({ configEnc, ...rest }) => ({
      ...rest,
      configSummary: summarizeConfig(rest.type, configEnc),
    }));
  });

  server.post<{ Params: { appId: string } }>("/apps/:appId/destinations", async (req, reply) => {
    const a = await appOrFail(req.params.appId);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;
    const body = StoreBody.parse(req.body);
    const config = parseConfig(body.type, body.config);
    assertNoEmptySecrets(body.type, config as Record<string, unknown>);
    const [created] = await db
      .insert(storeDestinations)
      .values({
        appId: a.id,
        name: body.name,
        type: body.type,
        bundleId: body.bundleId ?? null,
        trackOrChannel: body.trackOrChannel ?? null,
        configEnc: encryptString(JSON.stringify(config)),
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

  server.patch<{ Params: { id: string } }>("/destinations/:id", async (req, reply) => {
    const [d] = await db.select().from(storeDestinations).where(eq(storeDestinations.id, req.params.id)).limit(1);
    if (!d) return reply.notFound();
    const a = await appOrFail(d.appId);
    if (!a) return reply.notFound();
    await requireOrgMember(req, reply, a.orgId);
    if (reply.sent) return;

    const body = StorePatchBody.parse(req.body);
    const updates: Partial<typeof storeDestinations.$inferInsert> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.bundleId !== undefined) updates.bundleId = body.bundleId ?? null;
    if (body.trackOrChannel !== undefined) updates.trackOrChannel = body.trackOrChannel ?? null;
    // Config merge: callers pass only the fields they want to change. Empty
    // strings for secret fields mean "leave existing" — the UI hides current
    // values behind a "leave blank to keep" hint so an unchanged form would
    // post empty strings rather than the old ciphertext. Non-secret fields
    // (e.g. appleId email) overwrite normally.
    if (body.config) {
      // Validate the incoming patch against the destination's stored type so
      // the client can't post an app_store config to a play_store row.
      const parsedPatch = parseConfig(d.type as z.infer<typeof StoreType>, body.config);
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(decryptString(d.configEnc)) as Record<string, unknown>; } catch { /* corrupt — replace wholesale */ }
      const merged = mergeConfig(d.type, existing, parsedPatch as Record<string, unknown>);
      updates.configEnc = encryptString(JSON.stringify(merged));
    }

    if (Object.keys(updates).length === 0) return reply.badRequest("No fields to update");

    const [updated] = await db
      .update(storeDestinations)
      .set(updates)
      .where(eq(storeDestinations.id, d.id))
      .returning({
        id: storeDestinations.id,
        appId: storeDestinations.appId,
        name: storeDestinations.name,
        type: storeDestinations.type,
        bundleId: storeDestinations.bundleId,
        trackOrChannel: storeDestinations.trackOrChannel,
        createdAt: storeDestinations.createdAt,
        configEnc: storeDestinations.configEnc,
      });
    if (!updated) return reply.notFound();
    const { configEnc, ...rest } = updated;
    return { ...rest, configSummary: summarizeConfig(updated.type, configEnc) };
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
    // Newest-first list including everything the table needs (build target,
    // commit info, triggered-by) so the page doesn't have to make N+1 lookups.
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
        triggeredByName: users.name,
        triggeredByEmail: users.email,
        buildTarget: builds.target,
        buildCommitSha: builds.commitSha,
        buildCommitMessage: builds.commitMessage,
        buildBranch: builds.branch,
        buildCreatedAt: builds.createdAt,
      })
      .from(deployments)
      .innerJoin(storeDestinations, eq(storeDestinations.id, deployments.destinationId))
      .innerJoin(builds, eq(builds.id, deployments.buildId))
      .leftJoin(users, eq(users.id, deployments.createdByUserId))
      .where(eq(builds.appId, a.id))
      .orderBy(desc(deployments.createdAt))
      .limit(50);

    // The "Build" column shows #N — the sequential build number within the
    // app. Compute it here so we don't ship build rows to the client.
    const allBuilds = await db
      .select({ id: builds.id, createdAt: builds.createdAt })
      .from(builds)
      .where(eq(builds.appId, a.id))
      .orderBy(asc(builds.createdAt));
    const buildNumberById = new Map<string, number>();
    allBuilds.forEach((b, i) => buildNumberById.set(b.id, i + 1));

    return rows.map((r) => ({
      ...r,
      buildNumber: buildNumberById.get(r.buildId) ?? null,
    }));
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
