import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { apps, buildStacks, environmentVars, gitConnections } from "../../db/schema.js";
import { decryptString } from "../../lib/crypto.js";
import { env } from "../../env.js";
import { exec, resolveLinuxHost, withSsh } from "../ssh.js";
import { cloneUrlFor } from "../gitClone.js";
import type { Runner, RunnerContext } from "../runner.js";

/**
 * Builds a web target on the Linux Docker host: clone → run a configurable
 * build command in `LINUX_BUILD_WEB_IMAGE` → zip the dist dir → publish.
 */
export class LinuxDockerWebRunner implements Runner {
  async run(ctx: RunnerContext): Promise<{ artifacts: { kind: string; url: string; sizeBytes?: number }[] }> {
    if (ctx.build.target !== "web") throw new Error("LinuxDockerWebRunner only handles target=web");
    const host = await resolveLinuxHost();
    if (!host) throw new Error("Linux build host is not configured");
    await ctx.log(`Linux host (${host.source}): ${host.username}@${host.host}:${host.port}`);

    const [a] = await db.select().from(apps).where(eq(apps.id, ctx.app.id)).limit(1);
    if (!a?.gitConnectionId || !a.gitRepoFullName) throw new Error("App is not connected to a repo");
    const [conn] = await db.select().from(gitConnections).where(eq(gitConnections.id, a.gitConnectionId)).limit(1);
    if (!conn) throw new Error("Git connection missing");
    if (conn.provider !== "github" && conn.provider !== "gitlab" && conn.provider !== "bitbucket") {
      throw new Error(`Unknown git provider: ${conn.provider}`);
    }
    const token = decryptString(conn.accessTokenEnc);

    const orgId = a.orgId;
    const buildId = ctx.build.id;
    const remoteDir = `${host.remoteBase}/${orgId}/${buildId}`;
    const downloadsDir = `${host.downloadsBase}/${orgId}/${buildId}`;
    const cloneUrl = cloneUrlFor(conn.provider as "github" | "gitlab" | "bitbucket", a.gitRepoFullName, token);
    const safeAppName = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "app";
    const buildDate = new Date().toISOString().slice(0, 10).replaceAll("-", "_");
    const artifactName = `${safeAppName}_${buildDate}.zip`;
    const artifactDst = `${downloadsDir}/${artifactName}`;

    // Stack drives the Docker image. Fall back to the env default if unset
    // or if the build references a stack that has since been deleted.
    const [stack] = ctx.build.stackId
      ? await db.select().from(buildStacks).where(eq(buildStacks.id, ctx.build.stackId)).limit(1)
      : [];
    const dockerImage = stack?.image ?? env.LINUX_BUILD_WEB_IMAGE;

    return await withSsh(host, async (ssh) => {
      const run = async (cmd: string) => {
        const r = await exec(ssh, cmd, (line) => ctx.log(line));
        if (r.exitCode !== 0) throw new Error(formatCmdError(cmd, r.exitCode, r.outputTail));
      };

      await ctx.step("preparing", "running");
      try {
        await run(`mkdir -p ${shq(remoteDir)} ${shq(downloadsDir)}`);
        await run(`bash -lc ${shq(`set -e; cd ${shq(remoteDir)} && git init -q && git remote add origin ${shq(cloneUrl)} && git fetch --depth 1 origin ${shq(ctx.build.commitSha)} && git checkout -q FETCH_HEAD`)}`);
        await ctx.step("preparing", "success", 0);
      } catch (e) {
        await ctx.step("preparing", "failed", 1);
        throw e;
      }
      if (await ctx.isCancelled()) throw new Error("cancelled");

      await ctx.step("installing", "running");
      const dockerEnvFlags = await collectEnvFlags(ctx);
      const dockerCmd = [
        `docker run --rm`,
        `-v ${shq(`${remoteDir}:/workspace`)}`,
        `-v raidx-npm-cache:/root/.npm`,
        ...dockerEnvFlags,
        `-w /workspace`,
        shq(dockerImage),
        `sh -lc ${shq(env.LINUX_BUILD_WEB_COMMAND)}`,
      ].join(" ");

      try {
        await ctx.log(`docker run ${dockerImage} (stack: ${ctx.build.stackId ?? "—"}): ${env.LINUX_BUILD_WEB_COMMAND}`);
        await run(dockerCmd);
        await ctx.step("installing", "success", 0);
        await ctx.step("building", "success", 0);
      } catch (e) {
        // installing + building are bundled in one docker call (`npm ci` then
        // `npm run build` inside the same container). We can't tell which one
        // failed, so mark the entry phase failed and the rest skipped.
        await ctx.step("installing", "failed", 1);
        await ctx.step("building", "skipped");
        throw e;
      }

      if (await ctx.isCancelled()) throw new Error("cancelled");

      await ctx.step("packaging", "running");
      const distPath = `${remoteDir}/${env.LINUX_BUILD_WEB_DIST_DIR}`;
      await run(`bash -lc ${shq(`set -e; if [ ! -d ${shq(distPath)} ]; then echo "Dist dir not found: ${env.LINUX_BUILD_WEB_DIST_DIR}"; exit 1; fi; cd ${shq(remoteDir)} && (cd ${shq(env.LINUX_BUILD_WEB_DIST_DIR)} && zip -qr ${shq(artifactDst)} .)`)}`);
      await ctx.step("packaging", "success", 0);

      await ctx.step("publishing", "running");
      const sizeRes = await exec(ssh, `bash -lc ${shq(`stat -c %s ${shq(artifactDst)} 2>/dev/null || echo 0`)}`, () => {});
      const artifacts = [
        {
          kind: "web",
          url: `${host.downloadsBaseUrl}/${orgId}/${buildId}/${artifactName}`,
          ...(sizeRes.exitCode === 0 ? {} : {}),
        },
      ];
      await ctx.step("publishing", "success", 0);

      await ctx.step("cleanup", "running");
      try {
        await run(`bash -lc ${shq(`rm -rf ${shq(`${remoteDir}/node_modules`)}`)}`);
      } catch {
        /* ignore */
      }
      await ctx.step("cleanup", "success", 0);

      return { artifacts };
    });
  }
}

async function collectEnvFlags(ctx: RunnerContext): Promise<string[]> {
  if (!ctx.build.environmentId) return [];
  const vars = await db.select().from(environmentVars).where(eq(environmentVars.environmentId, ctx.build.environmentId));
  return vars.map((v) => `-e ${shq(`${v.key}=${decryptString(v.valueEnc)}`)}`);
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function formatCmdError(cmd: string, exitCode: number, outputTail: string): string {
  const summary = cmd.split("\n")[0]?.slice(0, 80) ?? "";
  const tail = outputTail.trim();
  if (!tail) return `Command failed (exit ${exitCode}): ${summary}`;
  return `Command failed (exit ${exitCode}): ${summary}\n${tail}`;
}
