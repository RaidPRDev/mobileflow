import { setTimeout as sleep } from "node:timers/promises";

/**
 * Sleep until at least `minDurationMs` has elapsed since `startMs`. No-op if
 * the work already exceeded the target. Used to flatten timing oracles on
 * branched endpoints (e.g. signup) where the "do something" path is slower
 * than the "do nothing" path.
 *
 * Important: this only equalizes timing under the assumption that the slower
 * branch reliably completes within `minDurationMs`. If a real signup ever
 * runs longer than the target (slow DB, GC pause) the duplicate branch will
 * appear faster and the oracle re-opens. Set the target generously above
 * observed p99 of the slower branch.
 */
export async function padToMinDuration(startMs: number, minDurationMs: number): Promise<void> {
  const remaining = minDurationMs - (Date.now() - startMs);
  if (remaining > 0) await sleep(remaining);
}
