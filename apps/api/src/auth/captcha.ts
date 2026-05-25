import { randomInt, randomUUID } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { captchas } from "../db/schema.js";

// In-process custom captcha. We generate a 6-character alphanumeric code,
// store it in the `captchas` table with a short TTL, and render an SVG
// image with random distortion so a naive OCR can't trivially read it.
// The client submits `{ captchaId, captchaCode }` alongside the login.
//
// Why pure-JS SVG instead of a canvas raster: SVG keeps the binary surface
// of this project zero (no node-canvas, no native deps), is tiny over the
// wire, and is still hostile to "just regex the response body" attackers
// because the characters are rendered as path/text glyphs with random
// rotation, noise lines, and dot speckle.
//
// CAPTCHA_TTL_MS is intentionally short: the user must solve it promptly.
// Single-use is enforced by the `consumed` flag — once a code passes
// verification it cannot be replayed.

const CAPTCHA_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 to reduce reader confusion
const CODE_LEN = 6;

export interface IssuedCaptcha {
  id: string;
  expiresAt: Date;
  svg: string;
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

function renderSvg(code: string): string {
  const W = 180;
  const H = 60;
  const noiseLines: string[] = [];
  for (let i = 0; i < 6; i++) {
    const x1 = randomInt(W);
    const y1 = randomInt(H);
    const x2 = randomInt(W);
    const y2 = randomInt(H);
    const stroke = `hsl(${randomInt(360)},60%,55%)`;
    noiseLines.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="1"/>`,
    );
  }
  for (let i = 0; i < 40; i++) {
    const cx = randomInt(W);
    const cy = randomInt(H);
    const fill = `hsl(${randomInt(360)},60%,40%)`;
    noiseLines.push(`<circle cx="${cx}" cy="${cy}" r="1" fill="${fill}"/>`);
  }

  const glyphs: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    const x = 18 + i * 26 + randomInt(6) - 3;
    const y = 38 + randomInt(8) - 4;
    const rot = randomInt(40) - 20;
    const fill = `hsl(${randomInt(360)},70%,30%)`;
    glyphs.push(
      `<text x="${x}" y="${y}" font-family="serif" font-size="32" font-weight="bold" fill="${fill}" transform="rotate(${rot} ${x} ${y})">${ch}</text>`,
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="100%" height="100%" fill="#f3f4f6"/>` +
    noiseLines.join("") +
    glyphs.join("") +
    `</svg>`
  );
}

export async function issueCaptcha(): Promise<IssuedCaptcha> {
  const code = randomCode();
  const expiresAt = new Date(Date.now() + CAPTCHA_TTL_MS);
  const id = randomUUID();
  await db.insert(captchas).values({ id, code, expiresAt });
  return { id, expiresAt, svg: renderSvg(code) };
}

/**
 * Verify a captcha submission. Single-use: a successful verify also marks
 * the row consumed so the same `{id, code}` pair cannot be replayed.
 *
 * Returns `true` on a clean match against a non-consumed, non-expired row.
 * All other outcomes (unknown id, wrong code, expired, already consumed)
 * return `false`. Callers MUST NOT distinguish these cases in the response
 * — that would let an attacker probe which captchas exist.
 */
export async function verifyCaptcha(id: string, code: string): Promise<boolean> {
  if (!id || !code) return false;
  const [row] = await db.select().from(captchas).where(eq(captchas.id, id)).limit(1);
  if (!row) return false;
  if (row.consumed) return false;
  if (row.expiresAt.getTime() <= Date.now()) return false;
  // Case-insensitive compare — the alphabet is all uppercase but users
  // routinely type lowercase. Treat trim() as well.
  if (row.code.toUpperCase() !== code.trim().toUpperCase()) return false;
  await db.update(captchas).set({ consumed: true }).where(eq(captchas.id, id));
  return true;
}

/** Periodic cleanup — call from a scheduled task. */
export async function purgeExpiredCaptchas(): Promise<void> {
  await db.delete(captchas).where(lt(captchas.expiresAt, new Date()));
}

/** Test helper: read the raw code so a script can solve the captcha. */
export async function _peekCaptchaCodeForTests(id: string): Promise<string | null> {
  const [row] = await db.select().from(captchas).where(and(eq(captchas.id, id))).limit(1);
  return row?.code ?? null;
}
