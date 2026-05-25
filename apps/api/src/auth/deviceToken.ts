import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { deviceTokens } from "../db/schema.js";

// Bearer tokens issued to the Tauri desktop client. Format: `mfd_<43 base64url chars>`.
// The `mfd_` prefix is purely for human-readability in logs and the devices UI
// (so a leaked secret in a paste is immediately recognizable as ours). The
// random payload is 32 bytes (256 bits) — same entropy as the web session id.
const TOKEN_PREFIX = "mfd_";
const RANDOM_BYTES = 32;
// First N chars of the raw token are stored in cleartext so the UI can show
// a fingerprint without keeping the secret. 8 chars of base64url ≈ 48 bits of
// uniqueness, plenty for visual disambiguation between a handful of devices.
const PREVIEW_LEN = 8;
// 90 days absolute expiry, 30 days idle expiry. The two are independent:
// whichever cutoff is reached first kills the token. We compute them at
// resolve time off `createdAt` / `lastUsedAt` so old rows that predate the
// expiresAt column still get the idle check applied.
export const TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const TOKEN_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssuedDeviceToken {
  id: string;
  /** Raw token — only ever returned to the user once. Never logged. */
  token: string;
  prefix: string;
  createdAt: Date;
  expiresAt: Date;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export async function issueDeviceToken(args: {
  userId: string;
  name: string;
}): Promise<IssuedDeviceToken> {
  const token = TOKEN_PREFIX + randomBytes(RANDOM_BYTES).toString("base64url");
  const tokenHash = hashToken(token);
  const tokenPrefix = token.slice(0, PREVIEW_LEN);
  const expiresAt = new Date(Date.now() + TOKEN_MAX_AGE_MS);
  const [row] = await db
    .insert(deviceTokens)
    .values({
      userId: args.userId,
      tokenHash,
      tokenPrefix,
      name: args.name,
      expiresAt,
    })
    .returning({ id: deviceTokens.id, createdAt: deviceTokens.createdAt });
  if (!row) throw new Error("device token insert failed");
  // Return the computed `expiresAt` directly — the schema column is
  // nullable to keep the migration non-breaking, but we always insert a
  // value so the return type stays non-null for callers.
  return { id: row.id, token, prefix: tokenPrefix, createdAt: row.createdAt, expiresAt };
}

// Resolve a raw bearer token to its row, or null if the token is unknown,
// revoked, expired, or malformed. Performs constant-time comparison of the
// stored hash to avoid timing attacks distinguishing "no such token" from
// "wrong token" on a fast-failing DB index lookup.
export async function resolveDeviceToken(raw: string) {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(raw);
  const [row] = await db
    .select()
    .from(deviceTokens)
    .where(and(eq(deviceTokens.tokenHash, tokenHash), isNull(deviceTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  const a = Buffer.from(tokenHash, "hex");
  const b = Buffer.from(row.tokenHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // Absolute expiry. row.expiresAt is required by schema for new rows; for
  // legacy rows missing the column the cast would have failed at select time
  // — defense in depth, treat a missing value as expired.
  const now = Date.now();
  if (!row.expiresAt || row.expiresAt.getTime() <= now) return null;
  // Idle expiry: lastUsedAt (or createdAt if never used) + IDLE window.
  const lastActivity = (row.lastUsedAt ?? row.createdAt).getTime();
  if (now - lastActivity > TOKEN_IDLE_MS) return null;
  return row;
}

export async function touchDeviceToken(id: string, ip: string | undefined): Promise<void> {
  await db
    .update(deviceTokens)
    .set({ lastUsedAt: new Date(), lastUsedIp: ip ?? null })
    .where(eq(deviceTokens.id, id));
}

export async function revokeDeviceToken(id: string, userId: string): Promise<boolean> {
  const [row] = await db
    .update(deviceTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(deviceTokens.id, id), eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)))
    .returning({ id: deviceTokens.id });
  return !!row;
}

export async function listDeviceTokens(userId: string) {
  return db
    .select({
      id: deviceTokens.id,
      name: deviceTokens.name,
      tokenPrefix: deviceTokens.tokenPrefix,
      createdAt: deviceTokens.createdAt,
      expiresAt: deviceTokens.expiresAt,
      lastUsedAt: deviceTokens.lastUsedAt,
      lastUsedIp: deviceTokens.lastUsedIp,
    })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)));
}
