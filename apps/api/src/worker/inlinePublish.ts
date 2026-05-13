import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { deployments, storeDestinations } from "../db/schema.js";
import { decryptString } from "../lib/crypto.js";
import { pickDeployRunner } from "./runners/deploySelector.js";
import type { DeployContext } from "./deployRunner.js";
import type { RunnerContext } from "./runner.js";

/**
 * Runs the store upload inline as part of the build's "publishing" phase
 * (instead of leaving it for the deployWorker). Creates the deployments
 * row, invokes the matching deploy runner, and streams log lines into both
 * the build log and the deployment log — so the same upload progress shows
 * up in the BuildPage pipeline view AND in the Deployments page row's log
 * modal. They're literally the same deployment record.
 *
 * The deployments row is created with status="running" (skipping the queue)
 * so the deployWorker's polling loop won't double-pick it.
 *
 * Callers are expected to call ctx.step("publishing", "running") before and
 * ctx.step("publishing", "success" | "failed") after — this helper only
 * handles the upload itself and the deployments row.
 */
export async function runInlinePublish(
  ctx: RunnerContext,
  artifacts: { kind: string; url: string; sizeBytes?: number }[],
): Promise<void> {
  const destinationId = ctx.build.autoDeployDestinationId;
  if (!destinationId) throw new Error("runInlinePublish called without autoDeployDestinationId");

  const [dest] = await db
    .select()
    .from(storeDestinations)
    .where(eq(storeDestinations.id, destinationId))
    .limit(1);
  if (!dest) throw new Error("Auto-deploy destination no longer exists");

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(decryptString(dest.configEnc)) as Record<string, unknown>;
  } catch {
    throw new Error("Destination config could not be decoded");
  }

  const [deployment] = await db
    .insert(deployments)
    .values({
      buildId: ctx.build.id,
      destinationId: dest.id,
      status: "running",
      createdByUserId: ctx.build.createdByUserId,
      startedAt: new Date(),
    })
    .returning();
  if (!deployment) throw new Error("Failed to create deployment row");

  await ctx.log(`Publishing to ${dest.name} (${dest.type}) — deployment ${deployment.id.slice(0, 8)}`);

  const appendDeploymentLog = async (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    await db
      .update(deployments)
      .set({ logText: sql`${deployments.logText} || ${stamped}` })
      .where(eq(deployments.id, deployment.id));
  };

  // Deploy runners read artifacts off ctx.build.artifacts; the worker writes
  // them to the DB only after the runner returns, so the in-memory copy is
  // the only place they exist at this point. Pass a shallow clone with the
  // artifacts inlined.
  const buildForDeploy = { ...ctx.build, artifacts };

  const deployCtx: DeployContext = {
    deployment,
    destination: dest,
    build: buildForDeploy,
    app: ctx.app,
    config: cfg,
    log: async (line: string) => {
      await ctx.log(line);
      await appendDeploymentLog(line);
    },
  };

  try {
    const runner = await pickDeployRunner(dest);
    await ctx.log(`Using deploy runner: ${runner.constructor.name}`);
    await runner.run(deployCtx);
    await db
      .update(deployments)
      .set({ status: "success", finishedAt: new Date() })
      .where(eq(deployments.id, deployment.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendDeploymentLog(`Deploy failed: ${msg}`);
    await db
      .update(deployments)
      .set({ status: "failed", finishedAt: new Date(), errorMessage: msg })
      .where(eq(deployments.id, deployment.id));
    throw err;
  }
}
