import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { buildHosts, buildStacks, builds } from "../db/schema.js";
import { env } from "../env.js";

export type HostKind = "linux_docker" | "mac";

/**
 * The scheduling identity of a build host — enough to gate concurrency without
 * opening SSH. `selector` is what gets written to builds.host_id at claim time:
 * a build_hosts.id for DB hosts, or "env:linux_docker" / "env:mac" for the
 * env-var-defined fallbacks (mirrors build_stacks.build_host_id semantics).
 */
export interface HostSlot {
  selector: string;
  name: string;
  capacity: number;
}

export function hostKindFor(target: "ios" | "android" | "web"): HostKind {
  return target === "ios" ? "mac" : "linux_docker";
}

/**
 * Resolve which host a queued build will run on. Mirrors the runner-side
 * resolution order (stack pin first, then first online DB host of the right
 * kind, then the env-defined host) so the worker gates on the same machine
 * the runner will actually use.
 *
 * Returns null when no host is resolvable — either nothing is configured
 * (StubRunner demo path) or a stack pin is broken. In both cases the claim
 * proceeds ungated and the runner produces the real, actionable error.
 */
export async function hostSlotForBuild(build: {
  target: "ios" | "android" | "web";
  stackId: string | null;
}): Promise<HostSlot | null> {
  const kind = hostKindFor(build.target);
  if (build.stackId) {
    const [stack] = await db.select().from(buildStacks).where(eq(buildStacks.id, build.stackId)).limit(1);
    const pin = stack?.buildHostId;
    if (pin) {
      if (pin === "env:mac" || pin === "env:linux_docker") return envSlot(kind);
      const [row] = await db.select().from(buildHosts).where(eq(buildHosts.id, pin)).limit(1);
      if (!row) return null;
      return { selector: row.id, name: row.name, capacity: row.capacity };
    }
  }
  const [row] = await db
    .select()
    .from(buildHosts)
    .where(and(eq(buildHosts.kind, kind), eq(buildHosts.online, true)))
    .limit(1);
  if (row) return { selector: row.id, name: row.name, capacity: row.capacity };
  return envSlot(kind);
}

function envSlot(kind: HostKind): HostSlot | null {
  if (kind === "linux_docker") {
    if (!env.LINUX_BUILD_HOST) return null;
    return { selector: "env:linux_docker", name: env.LINUX_BUILD_HOST, capacity: env.LINUX_BUILD_CAPACITY };
  }
  if (!env.MAC_BUILD_HOST || !env.MAC_BUILD_USER) return null;
  return { selector: "env:mac", name: env.MAC_BUILD_HOST, capacity: env.MAC_BUILD_CAPACITY };
}

/**
 * Slot indexes of the builds currently running on the given host (one entry
 * per build; null for rows claimed before slot assignment existed). host_id
 * is stamped by the worker at claim time, so rows that predate capacity
 * gating don't count — they drain out within one build cycle.
 */
export async function runningSlotsOnHost(selector: string): Promise<(number | null)[]> {
  const rows = await db
    .select({ slot: builds.hostSlot })
    .from(builds)
    .where(and(eq(builds.status, "running"), eq(builds.hostId, selector)));
  return rows.map((r) => r.slot);
}

/** Lowest slot index in [0, capacity) not held by a running build. */
export function lowestFreeSlot(usedSlots: (number | null)[], capacity: number): number {
  const used = new Set(usedSlots.filter((s): s is number => s !== null));
  for (let i = 0; i < capacity; i++) if (!used.has(i)) return i;
  // All indexed slots taken (only reachable when legacy null-slot rows padded
  // the count) — overflow past capacity rather than double-book a volume.
  return usedSlots.length;
}

export interface QueueInfo {
  hostName: string;
  capacity: number;
  running: number;
}

/**
 * Why a queued build hasn't started — powers the "waiting for a free build
 * slot" banner. Null when the build isn't blocked on capacity (it's just
 * waiting for the next worker tick, or no host is configured at all).
 */
export async function queueInfoFor(build: {
  target: "ios" | "android" | "web";
  stackId: string | null;
}): Promise<QueueInfo | null> {
  const slot = await hostSlotForBuild(build);
  if (!slot) return null;
  const running = (await runningSlotsOnHost(slot.selector)).length;
  if (running < slot.capacity) return null;
  return { hostName: slot.name, capacity: slot.capacity, running };
}
