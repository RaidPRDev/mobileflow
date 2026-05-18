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

export interface IssuedDeviceToken {
  id: string;
  /** Raw token — only ever returned to the user once. Never logged. */
  token: string;
  prefix: string;
  createdAt: Date;
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
  const [row] = await db
    .insert(deviceTokens)
    .values({
      userId: args.userId,
      tokenHash,
      tokenPrefix,
      name: args.name,
    })
    .returning({ id: deviceTokens.id, createdAt: deviceTokens.createdAt });
  if (!row) throw new Error("device token insert failed");
  return { id: row.id, token, prefix: tokenPrefix, createdAt: row.createdAt };
}

// Resolve a raw bearer token to its row, or null if the token is unknown,
// revoked, or malformed. Performs constant-time comparison of the stored
// hash to avoid timing attacks distinguishing "no such token" from
// "wrong token" on a fast-failing DB index lookup. (The DB lookup itself is
// by exact hash equality which is already constant-time from the attacker's
// perspective; the explicit timingSafeEqual is a belt-and-suspenders check
// for any future code that compares raw token values.)
export async function resolveDeviceToken(raw: string) {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(raw);
  const [row] = await db
    .select()
    .from(deviceTokens)
    .where(and(eq(deviceTokens.tokenHash, tokenHash), isNull(deviceTokens.revokedAt)))
    .limit(1);
  if (!row) return null;
  // Constant-time recheck on the hash buffers.
  const a = Buffer.from(tokenHash, "hex");
  const b = Buffer.from(row.tokenHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
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
      lastUsedAt: deviceTokens.lastUsedAt,
      lastUsedIp: deviceTokens.lastUsedIp,
    })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)));
}
