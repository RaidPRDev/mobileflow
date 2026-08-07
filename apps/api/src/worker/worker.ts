import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apps, buildSteps, builds, deployments, storeDestinations, type Build } from "../db/schema.js";
import type { RunnerContext } from "./runner.js";
import { pickRunner } from "./runners/selector.js";
import { buildBus } from "./events.js";
import { hostSlotForBuild, lowestFreeSlot, runningSlotsOnHost, type HostSlot } from "./hostCapacity.js";
import { sweepMacBuildSandboxes } from "./maintenance.js";
import { maskLogLine } from "../lib/maskLog.js";

let timer: NodeJS.Timeout | null = null;
let inFlight = 0;
// Process-level safety valve only — the real limiter is each host's capacity
// (build_hosts.capacity / LINUX_BUILD_CAPACITY / MAC_BUILD_CAPACITY), checked
// per queued build in tick(). Kept above the sum of typical host capacities so
// a saturated Linux host can't starve free Mac slots.
const MAX_CONCURRENCY = 8;

export function startWorker(intervalMs = 1500) {
  if (timer) return;
  // Builds execute in-process, so a row still 'running' at boot was orphaned
  // by a crash/restart and will never finish — left alone it would also pin
  // one of its host's capacity slots forever. Fail such rows up front.
  // (Assumes a single API instance, same as the in-process buildBus.)
  void db
    .update(builds)
    .set({ status: "failed", finishedAt: new Date(), errorMessage: "Build was interrupted by an API restart" })
    .where(eq(builds.status, "running"))
    .then((r) => {
      const n = (r as unknown as { rowCount?: number }).rowCount ?? 0;
      if (n > 0) console.log(`[worker] failed ${n} build(s) orphaned by the previous run`);
    })
    .catch((err) => console.error("[worker] orphaned-build sweep failed:", err));
  // Fire-and-forget sweep of orphan Mac build dirs. Runs in the background
  // while the polling loop starts — failures here must not delay the worker.
  void sweepMacBuildSandboxes();
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  timer = setInterval(() => void tick(), intervalMs);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  if (inFlight >= MAX_CONCURRENCY) return;
  // Oldest-first scan of the queue. A build whose host is at capacity stays
  // queued but must not block builds bound for other hosts (a waiting Android
  // build shouldn't starve a free Mac slot), so we walk past it.
  const queued = await db
    .select({ id: builds.id, target: builds.target, stackId: builds.stackId })
    .from(builds)
    .where(eq(builds.status, "queued"))
    .orderBy(asc(builds.createdAt))
    .limit(20);
  for (const q of queued) {
    const slot = await hostSlotForBuild(q);
    let slotIndex: number | null = null;
    if (slot) {
      const usedSlots = await runningSlotsOnHost(slot.selector);
      if (usedSlots.length >= slot.capacity) {
        await notifyWaitingForSlot(q.id, slot, usedSlots.length);
        continue;
      }
      slotIndex = lowestFreeSlot(usedSlots, slot.capacity);
    }
    // Atomically claim it, stamping the resolved host + concurrency slot so
    // capacity counting sees this build immediately and runners get a slot
    // no concurrent build shares. The status guard loses gracefully if
    // another API instance (or a cancel) got there first.
    const claimed = await db.execute<{ id: string }>(sql`
      UPDATE builds
      SET status = 'running', started_at = now(),
          host_id = ${slot?.selector ?? null}, host_slot = ${slotIndex}
      WHERE id = ${q.id} AND status = 'queued'
      RETURNING id
    `);
    const claimedRows = (claimed as unknown as { id: string }[]) ?? [];
    if (!claimedRows[0]) continue;
    waitingNotified.delete(q.id);
    inFlight++;
    void runOne(q.id).finally(() => {
      inFlight--;
    });
    return; // one claim per tick, as before
  }
}

// Build ids that already got their "waiting for a free slot" log line, so the
// 1.5s tick doesn't spam the stored log. Entries for builds cancelled while
// queued linger until restart — harmless, bounded by builds per process life.
const waitingNotified = new Set<string>();

async function notifyWaitingForSlot(buildId: string, slot: HostSlot, running: number) {
  // The bus event fires every tick so an open build page tracks the live
  // running/capacity numbers; the log line is written once as the durable
  // record of why the build sat in the queue.
  buildBus.emit(buildId, {
    type: "queue",
    waiting: true,
    hostName: slot.name,
    capacity: slot.capacity,
    running,
  });
  if (waitingNotified.has(buildId)) return;
  waitingNotified.add(buildId);
  await appendLog(
    buildId,
    `Build host "${slot.name}" is at its limit of ${slot.capacity} concurrent build${slot.capacity === 1 ? "" : "s"} — waiting for a free slot. The build starts automatically when a running build completes.`,
  );
}

async function runOne(buildId: string) {
  const [b] = await db.select().from(builds).where(eq(builds.id, buildId)).limit(1);
  if (!b) return;
  const [a] = await db.select().from(apps).where(eq(apps.id, b.appId)).limit(1);
  if (!a) {
    await fail(b, "App not found");
    return;
  }

  const ctx: RunnerContext = {
    build: b,
    app: a,
    log: (line: string) => appendLog(b.id, line),
    step: (name, status, exitCode) => updateStep(b.id, name, status, exitCode),
    isCancelled: async () => {
      const [latest] = await db.select({ status: builds.status }).from(builds).where(eq(builds.id, b.id)).limit(1);
      return latest?.status === "cancelled";
    },
  };

  // Include startedAt so the UI can tick the duration immediately, even when
  // the page opened before this tick claimed the row (in which case the WS
  // snapshot was sent with startedAt=null).
  buildBus.emit(b.id, { type: "status", status: "running", startedAt: b.startedAt?.toISOString() ?? null });

  try {
    await ctx.log(`Build ${b.id} started for ${a.name} (${b.target}, ${b.commitSha.slice(0, 7)})`);
    const runner = await pickRunner(b.target);
    await ctx.log(`Using runner: ${runner.constructor.name}`);
    const { artifacts = [] } = await runner.run(ctx);
    const finishedAt = new Date();
    await db.update(builds).set({ status: "success", finishedAt, artifacts }).where(eq(builds.id, b.id));
    await ctx.log(`Build complete. ${artifacts.length} artifact(s) ready.`);
    buildBus.emit(b.id, { type: "artifacts", artifacts });
    buildBus.emit(b.id, { type: "status", status: "success", finishedAt: finishedAt.toISOString() });
    await maybeQueueAutoDeploy(b, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "cancelled") {
      await ctx.log("Build cancelled.");
      buildBus.emit(b.id, { type: "status", status: "cancelled" });
    } else {
      const finishedAt = await fail(b, msg);
      await ctx.log(`Build failed: ${msg}`);
      buildBus.emit(b.id, { type: "status", status: "failed", errorMessage: msg, finishedAt: finishedAt.toISOString() });
    }
  }
}

async function maybeQueueAutoDeploy(b: Build, ctx: RunnerContext) {
  if (!b.autoDeployDestinationId) return;
  // Real runners (LinuxDocker/Mac) run the store upload inline during their
  // "publishing" phase via runInlinePublish, which already creates the
  // deployments row. Only queue here if no row exists yet — that's the
  // StubRunner / web fallback path so demos still see a deployment record.
  const existing = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(eq(deployments.buildId, b.id))
    .limit(1);
  if (existing.length > 0) return;
  try {
    const [dest] = await db
      .select({ id: storeDestinations.id, name: storeDestinations.name })
      .from(storeDestinations)
      .where(eq(storeDestinations.id, b.autoDeployDestinationId))
      .limit(1);
    if (!dest) {
      await ctx.log("Auto-deploy: destination no longer exists, skipping.");
      return;
    }
    const [created] = await db
      .insert(deployments)
      .values({
        buildId: b.id,
        destinationId: dest.id,
        status: "queued",
        createdByUserId: b.createdByUserId,
      })
      .returning({ id: deployments.id });
    await ctx.log(`Auto-deploy queued to ${dest.name} (deployment ${created?.id.slice(0, 8)}).`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.log(`Auto-deploy failed to queue: ${msg}`);
  }
}

async function fail(b: Build, message: string): Promise<Date> {
  const finishedAt = new Date();
  await db
    .update(builds)
    .set({ status: "failed", finishedAt, errorMessage: message })
    .where(eq(builds.id, b.id));
  return finishedAt;
}

async function appendLog(buildId: string, line: string) {
  const stamped = `${new Date().toISOString()} ${maskLogLine(line)}\n`;
  const [updated] = await db
    .update(builds)
    .set({ logText: sql`${builds.logText} || ${stamped}` })
    .where(eq(builds.id, buildId))
    .returning({ length: sql<number>`length(${builds.logText})` });
  buildBus.emit(buildId, { type: "log", line: stamped, offset: updated?.length ?? 0 });
}

async function updateStep(
  buildId: string,
  name: string,
  status: "running" | "success" | "failed" | "skipped",
  exitCode?: number,
) {
  const patch: Record<string, unknown> = { status };
  if (status === "running") patch.startedAt = new Date();
  if (status !== "running") {
    patch.endedAt = new Date();
    if (exitCode !== undefined) patch.exitCode = exitCode;
  }
  await db
    .update(buildSteps)
    .set(patch)
    .where(sql`build_id = ${buildId} AND name = ${name}`);
  buildBus.emit(buildId, { type: "step", name, status, ...(exitCode !== undefined ? { exitCode } : {}) });
}
