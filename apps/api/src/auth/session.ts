import { randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { sessions } from "../db/schema.js";

export const SESSION_COOKIE = "mf_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

export async function createSession(args: {
  userId: string;
  userAgent?: string | undefined;
  ip?: string | undefined;
}): Promise<{ id: string; expiresAt: Date }> {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id,
    userId: args.userId,
    expiresAt,
    userAgent: args.userAgent ?? null,
    ip: args.ip ?? null,
  });
  return { id, expiresAt };
}

export async function getSession(id: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  return row;
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

export async function purgeExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
