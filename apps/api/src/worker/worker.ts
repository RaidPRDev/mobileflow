import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apps, buildSteps, builds, deployments, storeDestinations, type Build } from "../db/schema.js";
import type { RunnerContext } from "./runner.js";
import { pickRunner } from "./runners/selector.js";
import { buildBus } from "./events.js";
import { sweepMacBuildSandboxes } from "./maintenance.js";

let timer: NodeJS.Timeout | null = null;
let inFlight = 0;
const MAX_CONCURRENCY = 2;

export function startWorker(intervalMs = 1500) {
  if (timer) return;
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
  // Atomically claim one queued build.
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE builds
    SET status = 'running', started_at = now()
    WHERE id = (
      SELECT id FROM builds WHERE status = 'queued'
      ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id
  `);
  const claimedRows = (claimed as unknown as { id: string }[]) ?? [];
  const row = claimedRows[0];
  if (!row) return;
  inFlight++;
  void runOne(row.id).finally(() => {
    inFlight--;
  });
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

  buildBus.emit(b.id, { type: "status", status: "running" });

  try {
    await ctx.log(`Build ${b.id} started for ${a.name} (${b.target}, ${b.commitSha.slice(0, 7)})`);
    const runner = await pickRunner(b.target);
    await ctx.log(`Using runner: ${runner.constructor.name}`);
    const { artifacts = [] } = await runner.run(ctx);
    await db.update(builds).set({ status: "success", finishedAt: new Date(), artifacts }).where(eq(builds.id, b.id));
    await ctx.log(`Build complete. ${artifacts.length} artifact(s) ready.`);
    buildBus.emit(b.id, { type: "artifacts", artifacts });
    buildBus.emit(b.id, { type: "status", status: "success" });
    await maybeQueueAutoDeploy(b, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "cancelled") {
      await ctx.log("Build cancelled.");
      buildBus.emit(b.id, { type: "status", status: "cancelled" });
    } else {
      await fail(b, msg);
      await ctx.log(`Build failed: ${msg}`);
      buildBus.emit(b.id, { type: "status", status: "failed", errorMessage: msg });
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

async function fail(b: Build, message: string) {
  await db
    .update(builds)
    .set({ status: "failed", finishedAt: new Date(), errorMessage: message })
    .where(eq(builds.id, b.id));
}

async function appendLog(buildId: string, line: string) {
  const stamped = `${new Date().toISOString()} ${line}\n`;
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
