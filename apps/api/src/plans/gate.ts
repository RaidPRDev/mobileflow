import { count, eq, isNull, and, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { apps, builds, plans, subscriptions } from "../db/schema.js";

export async function getOrgPlan(orgId: string) {
  const [row] = await db
    .select({
      planId: subscriptions.planId,
      maxApps: plans.maxApps,
      maxSeats: plans.maxSeats,
      maxConcurrentBuilds: plans.maxConcurrentBuilds,
      canBuild: plans.canBuild,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.orgId, orgId))
    .limit(1);
  return row ?? null;
}

type GateOpts = { isSuperadmin?: boolean };

export async function assertCanCreateApp(
  orgId: string,
  opts: GateOpts = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.isSuperadmin) return { ok: true };
  const plan = await getOrgPlan(orgId);
  if (!plan) return { ok: false, reason: "No active subscription" };
  if (plan.maxApps == null) return { ok: true }; // unlimited
  const [c] = await db.select({ n: count() }).from(apps).where(and(eq(apps.orgId, orgId), isNull(apps.deletedAt)));
  const used = c?.n ?? 0;
  if (used >= plan.maxApps) return { ok: false, reason: `Plan limit reached (${plan.maxApps} apps). Upgrade to add more.` };
  return { ok: true };
}

export async function assertCanStartBuild(
  orgId: string,
  opts: GateOpts = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (opts.isSuperadmin) return { ok: true };
  const plan = await getOrgPlan(orgId);
  if (!plan) return { ok: false, reason: "No active subscription" };
  if (!plan.canBuild) return { ok: false, reason: "Your plan does not include builds. Upgrade to start building." };
  if (plan.maxConcurrentBuilds == null) return { ok: true };
  const orgApps = await db.select({ id: apps.id }).from(apps).where(and(eq(apps.orgId, orgId), isNull(apps.deletedAt)));
  if (orgApps.length === 0) return { ok: true };
  const ids = orgApps.map((a) => a.id);
  const [c] = await db
    .select({ n: count() })
    .from(builds)
    .where(and(inArray(builds.appId, ids), inArray(builds.status, ["queued", "running"] as const)));
  const inFlight = c?.n ?? 0;
  if (inFlight >= plan.maxConcurrentBuilds) {
    return { ok: false, reason: `Concurrent build limit reached (${plan.maxConcurrentBuilds}). Wait for one to finish or upgrade.` };
  }
  return { ok: true };
}
