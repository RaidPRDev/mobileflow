import { eq } from "drizzle-orm";
import { Client } from "ssh2";
import { db } from "../../db/client.js";
import { apps, certificates, environmentVars, gitConnections } from "../../db/schema.js";
import { decryptString } from "../../lib/crypto.js";
import { env } from "../../env.js";
import { exec, resolveLinuxHost, withSsh } from "../ssh.js";
import { cloneUrlFor } from "../gitClone.js";
import type { Runner, RunnerContext } from "../runner.js";

/**
 * Ports `References/XBuildApi/xbuild/uploadAndBuildAndroid.sh` to the in-process
 * worker. Differences from the reference:
 *   - No zip-and-upload — clones the repo on the host using a short-lived
 *     OAuth token (avoids round-tripping the source through the API box).
 *   - No reliance on a global .env on the host — every parameter is passed via
 *     `docker run -e`, including per-build env vars from the selected
 *     environment and (when wired) Android signing material.
 *   - Streams stdout/stderr through `ctx.log` so the live build view tails it.
 *
 * Required on the host:
 *   - `git`, `docker` available to LINUX_BUILD_USER
 *   - The image LINUX_BUILD_ANDROID_IMAGE present (or Dockerfile in TOOLS dir)
 *   - LINUX_BUILD_ANDROID_TOOLS contains `main_build.sh` and a `Dockerfile`
 *     that match the existing RaidX Android build conventions.
 */
export class LinuxDockerAndroidRunner implements Runner {
  async run(ctx: RunnerContext): Promise<{ artifacts: { kind: string; url: string; sizeBytes?: number }[] }> {
    if (ctx.build.target !== "android") throw new Error("LinuxDockerAndroidRunner only handles target=android");
    const host = await resolveLinuxHost();
    if (!host) throw new Error("Linux build host is not configured (no DB row and no LINUX_BUILD_* env)");
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
    const androidTools = host.toolsPath ?? env.LINUX_BUILD_ANDROID_TOOLS;
    const cloneUrl = cloneUrlFor(conn.provider as "github" | "gitlab" | "bitbucket", a.gitRepoFullName, token);
    const safeAppName = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "app";
    const buildDate = new Date().toISOString().slice(0, 10).replaceAll("-", "_");
    const artifactBase = `${safeAppName}_${buildDate}`;

    return await withSsh(host, async (ssh) => {
      const run = async (cmd: string) => {
        const r = await exec(ssh, cmd, (line) => ctx.log(line));
        if (r.exitCode !== 0) throw new Error(`command failed (exit ${r.exitCode}): ${cmd.split("\n")[0]?.slice(0, 80)}…`);
      };

      // --- preparing ---
      await ctx.step("preparing", "running");
      try {
        await run(`mkdir -p ${shq(remoteDir)} ${shq(downloadsDir)}`);
        await ctx.log(`Cloning ${a.gitRepoFullName} @ ${ctx.build.commitSha.slice(0, 7)}`);
        // Clone, then checkout the exact SHA. --depth 1 + fetch to keep it small.
        await run(`bash -lc ${shq(`set -e; cd ${shq(remoteDir)} && git init -q && git remote add origin ${shq(cloneUrl)} && git fetch --depth 1 origin ${shq(ctx.build.commitSha)} && git checkout -q FETCH_HEAD`)}`);
        await ctx.step("preparing", "success", 0);
      } catch (e) {
        await ctx.step("preparing", "failed", 1);
        throw e;
      }

      if (await ctx.isCancelled()) throw new Error("cancelled");

      // --- installing + building + signing + packaging (all inside the build container) ---
      await ctx.step("installing", "running");
      let keystoreFlags: string[];
      try {
        keystoreFlags = await materializeAndroidKeystore(ssh, orgId, remoteDir, ctx);
      } catch (e) {
        await ctx.log(`Signing certificate error: ${e instanceof Error ? e.message : String(e)}`);
        await ctx.step("installing", "failed", 1);
        throw e;
      }
      const dockerEnv = await collectEnvFlags(ctx);
      const dockerCmd = [
        `docker run --rm`,
        `-v ${shq(`${remoteDir}:/workspace`)}`,
        `-v ${shq(`${androidTools}:/tools`)}`,
        `-v raidx-gradle-cache:/root/.gradle`,
        `-e BUILD_ID=${shq(buildId)}`,
        `-e CLIENT_ID=${shq(orgId)}`,
        `-e MODE=build`,
        ...dockerEnv,
        ...keystoreFlags,
        `-w /workspace`,
        shq(env.LINUX_BUILD_ANDROID_IMAGE),
        `bash /tools/main_build.sh`,
      ].join(" ");

      try {
        await ctx.log(`docker run ${env.LINUX_BUILD_ANDROID_IMAGE}`);
        await run(dockerCmd);
        await ctx.step("installing", "success", 0);
        await ctx.step("building", "success", 0);
        await ctx.step("signing", "success", 0);
        await ctx.step("packaging", "success", 0);
      } catch (e) {
        // We can't tell which sub-phase failed without parsing the script's
        // structured events; mark the latest "running" step failed.
        for (const name of ["installing", "building", "signing", "packaging"] as const) {
          await ctx.step(name, "failed", 1);
        }
        throw e;
      }

      if (await ctx.isCancelled()) throw new Error("cancelled");

      // --- publishing ---
      await ctx.step("publishing", "running");
      const aabSrc = `${remoteDir}/android/app/build/outputs/bundle/release/app-release.aab`;
      const apkSrc = `${remoteDir}/android/app/build/outputs/apk/release/app-release.apk`;
      const aabDst = `${downloadsDir}/${artifactBase}.aab`;
      const apkDst = `${downloadsDir}/${artifactBase}.apk`;
      await run(`bash -lc ${shq(`set -e; [ -f ${shq(aabSrc)} ] && cp ${shq(aabSrc)} ${shq(aabDst)} || true; [ -f ${shq(apkSrc)} ] && cp ${shq(apkSrc)} ${shq(apkDst)} || true`)}`);
      await ctx.step("publishing", "success", 0);

      const artifacts: { kind: string; url: string }[] = [];
      const checkAndAdd = async (path: string, kind: string, urlPath: string) => {
        const r = await exec(ssh, `[ -f ${shq(path)} ] && echo present || echo missing`, () => {});
        if (r.exitCode === 0) artifacts.push({ kind, url: `${host.downloadsBaseUrl}${urlPath}` });
      };
      await checkAndAdd(aabDst, "aab", `/${orgId}/${buildId}/${artifactBase}.aab`);
      await checkAndAdd(apkDst, "apk", `/${orgId}/${buildId}/${artifactBase}.apk`);

      // --- cleanup (best-effort; ignore failures) ---
      await ctx.step("cleanup", "running");
      try {
        await run(`bash -lc ${shq(`rm -rf ${shq(`${remoteDir}/node_modules`)} ${shq(`${remoteDir}/android/.gradle`)}`)}`);
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
  const vars = await db
    .select()
    .from(environmentVars)
    .where(eq(environmentVars.environmentId, ctx.build.environmentId));
  return vars.map((v) => `-e ${shq(`${v.key}=${decryptString(v.valueEnc)}`)}`);
}

/**
 * Materialize the keystore selected on the build (build.certificateId). Writes
 * it into {remoteDir}/certs/google/<fileName> and emits the env flags
 * `main_build.sh` expects (ANDROID_KEYSTORE, ANDROID_KEYSTORE_PASS,
 * ANDROID_ALIAS, ANDROID_ACCOUNT_ID, ANDROID_EMAIL — pulled from metadata).
 * Throws if no certificate is selected or the selection is invalid.
 */
async function materializeAndroidKeystore(
  ssh: Client,
  orgId: string,
  remoteDir: string,
  ctx: RunnerContext,
): Promise<string[]> {
  const certificateId = ctx.build.certificateId;
  if (!certificateId) {
    throw new Error("No signing certificate selected for this build — pick a keystore when starting the build.");
  }
  const [cert] = await db
    .select()
    .from(certificates)
    .where(eq(certificates.id, certificateId))
    .limit(1);
  if (!cert) throw new Error(`Signing certificate ${certificateId} not found.`);
  if (cert.orgId !== orgId) throw new Error("Signing certificate does not belong to this app's organization.");
  if (cert.platform !== "android") throw new Error(`Selected signing certificate is for ${cert.platform}, not Android.`);
  if (cert.kind !== "keystore") throw new Error(`Selected signing certificate must be a keystore (got kind=${cert.kind}).`);

  const remotePath = `${remoteDir}/certs/google/${cert.fileName}`;
  const blobBase64 = decryptString(cert.fileBlobEnc);
  await new Promise<void>((resolve, reject) => {
    ssh.exec(`mkdir -p ${shq(`${remoteDir}/certs/google`)} && base64 -d > ${shq(remotePath)}`, (err, stream) => {
      if (err) return reject(err);
      stream.on("close", (code: number | null) => (code === 0 ? resolve() : reject(new Error(`keystore upload failed (${code})`))));
      stream.write(blobBase64);
      stream.end();
    });
  });
  await ctx.log(`Materialized keystore: ${cert.fileName}`);

  const meta = (cert.metadata ?? {}) as Record<string, string>;
  const password = cert.passwordEnc ? decryptString(cert.passwordEnc) : "";
  const flags = [
    `-e ${shq(`ANDROID_KEYSTORE=/workspace/certs/google/${cert.fileName}`)}`,
    `-e ${shq(`ANDROID_KEYSTORE_PASS=${password}`)}`,
  ];
  if (meta.alias) flags.push(`-e ${shq(`ANDROID_ALIAS=${meta.alias}`)}`);
  if (meta.accountId) flags.push(`-e ${shq(`ANDROID_ACCOUNT_ID=${meta.accountId}`)}`);
  if (meta.email) flags.push(`-e ${shq(`ANDROID_EMAIL=${meta.email}`)}`);
  return flags;
}

/** Shell-quote a value for safe inclusion in a remote bash command. */
function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
