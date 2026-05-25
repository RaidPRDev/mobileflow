import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { loginAttempts } from "../db/schema.js";

// Per-email login-attempt accounting. We record every failed login keyed by
// the lowercased email, then count recent failures to decide whether the
// next attempt must include a solved captcha. We do NOT record successful
// logins here — a clean login resets the counter via `clearFailedAttempts`.
//
// The window is short on purpose: an attacker burning through a wordlist
// will trip the captcha gate within seconds, but a forgetful real user
// regains friction-free login within minutes once they stop typoing.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const CAPTCHA_THRESHOLD = 3;

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function recordFailedAttempt(email: string, ip: string | undefined): Promise<void> {
  await db.insert(loginAttempts).values({
    email: normEmail(email),
    ip: ip ?? null,
  });
}

export async function countRecentFailures(email: string): Promise<number> {
  const cutoff = new Date(Date.now() - WINDOW_MS);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.email, normEmail(email)), gt(loginAttempts.createdAt, cutoff)));
  return row?.n ?? 0;
}

export async function clearFailedAttempts(email: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.email, normEmail(email)));
}

/**
 * Whether the next login attempt for this email must include a captcha
 * solution. Returns true once the rolling failure count meets the threshold,
 * and stays true until a successful login (which clears the table) or the
 * window expires (which naturally drops the count).
 */
export async function isCaptchaRequired(email: string): Promise<boolean> {
  const n = await countRecentFailures(email);
  return n >= CAPTCHA_THRESHOLD;
}

export const CAPTCHA_AFTER_FAILS = CAPTCHA_THRESHOLD;
