import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apps, builds, deployments, storeDestinations } from "../db/schema.js";
import { decryptString } from "../lib/crypto.js";
import { pickDeployRunner } from "./runners/deploySelector.js";
import type { DeployContext } from "./deployRunner.js";

let timer: NodeJS.Timeout | null = null;
let inFlight = 0;
const MAX_CONCURRENCY = 1;

export function startDeployWorker(intervalMs = 2000) {
  if (timer) return;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  timer = setInterval(() => void tick(), intervalMs);
}

async function tick() {
  if (inFlight >= MAX_CONCURRENCY) return;
  const claimed = await db.execute<{ id: string }>(sql`
    UPDATE deployments
    SET status = 'running', started_at = now()
    WHERE id = (
      SELECT id FROM deployments WHERE status = 'queued'
      ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING id
  `);
  const rows = (claimed as unknown as { id: string }[]) ?? [];
  const row = rows[0];
  if (!row) return;
  inFlight++;
  void runOne(row.id).finally(() => {
    inFlight--;
  });
}

async function runOne(id: string) {
  const [d] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
  if (!d) return;
  const [dest] = await db.select().from(storeDestinations).where(eq(storeDestinations.id, d.destinationId)).limit(1);
  if (!dest) return await fail(id, "destination missing");
  const [b] = await db.select().from(builds).where(eq(builds.id, d.buildId)).limit(1);
  if (!b) return await fail(id, "build missing");
  const [a] = await db.select().from(apps).where(eq(apps.id, b.appId)).limit(1);
  if (!a) return await fail(id, "app missing");

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(decryptString(dest.configEnc)) as Record<string, unknown>;
  } catch {
    return await fail(id, "destination config could not be decoded");
  }

  const append = async (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    await db.update(deployments).set({ logText: sql`${deployments.logText} || ${stamped}` }).where(eq(deployments.id, id));
  };

  const ctx: DeployContext = {
    deployment: d,
    destination: dest,
    build: b,
    app: a,
    config: cfg,
    log: append,
  };

  try {
    const runner = await pickDeployRunner(dest);
    await append(`Using deploy runner: ${runner.constructor.name}`);
    await runner.run(ctx);
    await db.update(deployments).set({ status: "success", finishedAt: new Date() }).where(eq(deployments.id, id));
    await append("Deployment complete.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await append(`Deploy failed: ${msg}`);
    await db
      .update(deployments)
      .set({ status: "failed", finishedAt: new Date(), errorMessage: msg })
      .where(eq(deployments.id, id));
  }
}

async function fail(id: string, message: string) {
  await db
    .update(deployments)
    .set({ status: "failed", finishedAt: new Date(), errorMessage: message })
    .where(eq(deployments.id, id));
}
