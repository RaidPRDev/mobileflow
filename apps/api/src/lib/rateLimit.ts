import type { FastifyReply, FastifyRequest } from "fastify";

// In-memory sliding-window rate limiter. Sufficient for a single-process
// deployment behind one reverse proxy. For horizontal scaling, swap this
// module for a Redis-backed implementation — call sites won't change.
//
// Each `bucket` is keyed by an arbitrary string (e.g. "login:ip:1.2.3.4" or
// "signup:ip:1.2.3.4"). The window length and the cap are passed by the
// caller, so the same limiter can serve aggressive (signup) and lenient
// (read endpoint) policies side by side.

interface Window {
  // monotonically-increasing list of timestamps (ms since epoch). We keep
  // them as a plain array because windows are short (minutes) and caps are
  // small (tens of attempts), so the linear shift on each hit is cheap.
  hits: number[];
}

const store = new Map<string, Window>();

// Sweep stale buckets out so the map doesn't grow without bound when the
// process is long-lived and sees a long tail of one-time client IPs. We
// don't need precision — running every 5 minutes is fine.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let sweepTimer: NodeJS.Timeout | null = null;
function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - 60 * 60 * 1000; // anything older than 1h is dead weight
    for (const [k, w] of store) {
      const lastHit = w.hits[w.hits.length - 1];
      if (lastHit === undefined || lastHit < cutoff) store.delete(k);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export interface RateLimitOptions {
  /** Bucket prefix, used together with `keyParts` to form the storage key. */
  bucket: string;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum allowed hits within the window. */
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the oldest hit in the window ages out. */
  retryAfterSec: number;
}

/** Check (and record) a hit. Pure function over the in-memory store. */
export function consume(
  bucket: string,
  keyParts: (string | undefined | null)[],
  opts: { windowMs: number; max: number },
): RateLimitResult {
  ensureSweeper();
  const key = `${bucket}:${keyParts.map((p) => p ?? "_").join("|")}`;
  const now = Date.now();
  const cutoff = now - opts.windowMs;
  const existing = store.get(key) ?? { hits: [] };
  // Drop expired hits before deciding.
  while (existing.hits.length > 0 && existing.hits[0]! < cutoff) existing.hits.shift();

  if (existing.hits.length >= opts.max) {
    store.set(key, existing);
    const oldest = existing.hits[0]!;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + opts.windowMs - now) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }

  existing.hits.push(now);
  store.set(key, existing);
  return { allowed: true, remaining: opts.max - existing.hits.length, retryAfterSec: 0 };
}

/** Drop all recorded hits for a key. Use on successful login to reset. */
export function reset(bucket: string, keyParts: (string | undefined | null)[]): void {
  const key = `${bucket}:${keyParts.map((p) => p ?? "_").join("|")}`;
  store.delete(key);
}

/**
 * Build a Fastify preHandler that enforces a limit on the given bucket,
 * keyed by `req.ip` (and optionally a body-derived identifier).
 *
 * `bodyKey` is a function so it can return a normalized email *after* zod
 * parsing has happened in the handler — but since preHandler runs first,
 * callers that need a body key should call `consume` manually from inside
 * the route. This helper is for pure-IP limits like signup throttling.
 */
export function ipRateLimit(opts: RateLimitOptions) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const r = consume(opts.bucket, [req.ip], { windowMs: opts.windowMs, max: opts.max });
    if (!r.allowed) {
      reply.header("Retry-After", r.retryAfterSec.toString());
      return reply.code(429).send({ error: "TooManyRequests" });
    }
  };
}

/** Test-only: clear all buckets. Exposed so test scripts can reset state. */
export function _resetAllForTests(): void {
  store.clear();
}
