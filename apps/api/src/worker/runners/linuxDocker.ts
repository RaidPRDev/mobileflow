import { eq } from "drizzle-orm";
import { Client } from "ssh2";
import { db } from "../../db/client.js";
import { apps, buildStacks, certificates, environmentVars, gitConnections } from "../../db/schema.js";
import { decryptString } from "../../lib/crypto.js";
import { safeBasename } from "../../lib/safePath.js";
import { env } from "../../env.js";
import { exec, execDrained, resolveLinuxHost, uploadBase64, withSsh } from "../ssh.js";
import { runInlinePublish } from "../inlinePublish.js";
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

    // Stack drives the Docker image the build runs in. We fall back to the
    // env default if the stack has no image set (or if the build references
    // a stack that no longer exists — historical builds shouldn't fail just
    // because an admin renamed a stack).
    const [stack] = ctx.build.stackId
      ? await db.select().from(buildStacks).where(eq(buildStacks.id, ctx.build.stackId)).limit(1)
      : [];
    const dockerImage = stack?.image ?? env.LINUX_BUILD_ANDROID_IMAGE;
    const cloneUrl = cloneUrlFor(conn.provider as "github" | "gitlab" | "bitbucket", a.gitRepoFullName, token);
    const safeAppName = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "app";
    const buildDate = new Date().toISOString().slice(0, 10).replaceAll("-", "_");
    const artifactBase = `${safeAppName}_${buildDate}`;

    return await withSsh(host, async (ssh) => {
      // Single AbortController across every exec() in this run. When the user
      // cancels, we abort, which closes the SSH channel and sends SIGHUP to
      // the remote shell. `docker run` is its own foreground process and
      // forwards SIGTERM/SIGHUP to PID 1 in the container, so the build
      // inside the container dies along with the ssh-side bash.
      const abortCtl = new AbortController();
      const cancelPoll = setInterval(() => {
        if (abortCtl.signal.aborted) return;
        void ctx.isCancelled().then((c) => {
          if (c && !abortCtl.signal.aborted) {
            void ctx.log("Cancellation requested — aborting remote build…");
            abortCtl.abort();
          }
        }).catch(() => { /* ignore poll errors */ });
      }, 1000);

      const run = async (cmd: string) => {
        const r = await exec(ssh, cmd, (line) => ctx.log(line), abortCtl.signal);
        if (abortCtl.signal.aborted) throw new Error("cancelled");
        if (r.exitCode !== 0) throw new Error(formatCmdError(cmd, r.exitCode, r.outputTail));
      };

      // Best-effort kill of stragglers after the channel is closed by abort.
      // `docker run --rm` normally tears the container down when its bash
      // parent exits via SIGHUP, so this mostly catches host-side stragglers.
      const killRemoteBuildProcs = async () => {
        try {
          await exec(
            ssh,
            `bash -lc ${shq(`pkill -f ${shq(buildId)} 2>/dev/null || true`)}`,
            () => {},
          );
        } catch {
          /* best-effort */
        }
      };

      try {
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
        keystoreFlags = await materializeAndroidKeystore(ssh, remoteDir, ctx);
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
        shq(dockerImage),
        `bash /tools/main_build.sh`,
      ].join(" ");

      try {
        await ctx.log(`docker run ${dockerImage} (stack: ${ctx.build.stackId ?? "—"})`);
        await run(dockerCmd);
        await ctx.step("installing", "success", 0);
        await ctx.step("building", "success", 0);
        await ctx.step("signing", "success", 0);
      } catch (e) {
        // installing/building/signing run inside one docker call
        // (main_build.sh), so we cannot tell which sub-phase actually failed
        // without instrumenting that script. Mark the entry phase failed and
        // the remaining phases skipped rather than lying that all three failed.
        await ctx.step("installing", "failed", 1);
        for (const name of ["building", "signing", "packaging"] as const) {
          await ctx.step(name, "skipped");
        }
        throw e;
      }

      if (await ctx.isCancelled()) throw new Error("cancelled");

      // --- packaging: move artifacts to the downloads server so they're at a
      // stable URL (the publishing phase, if present, fetches over HTTP). ---
      await ctx.step("packaging", "running");
      const artifacts: { kind: string; url: string }[] = [];
      try {
        const aabSrc = `${remoteDir}/android/app/build/outputs/bundle/release/app-release.aab`;
        const apkSrc = `${remoteDir}/android/app/build/outputs/apk/release/app-release.apk`;
        const aabDst = `${downloadsDir}/${artifactBase}.aab`;
        const apkDst = `${downloadsDir}/${artifactBase}.apk`;
        await run(`bash -lc ${shq(`set -e; [ -f ${shq(aabSrc)} ] && cp ${shq(aabSrc)} ${shq(aabDst)} || true; [ -f ${shq(apkSrc)} ] && cp ${shq(apkSrc)} ${shq(apkDst)} || true`)}`);

        const checkAndAdd = async (path: string, kind: string, urlPath: string) => {
          const r = await exec(ssh, `[ -f ${shq(path)} ] && echo present || echo missing`, () => {});
          if (r.exitCode === 0) artifacts.push({ kind, url: `${host.downloadsBaseUrl}${urlPath}` });
        };
        await checkAndAdd(aabDst, "aab", `/${orgId}/${buildId}/${artifactBase}.aab`);
        await checkAndAdd(apkDst, "apk", `/${orgId}/${buildId}/${artifactBase}.apk`);
        await ctx.step("packaging", "success", 0);
      } catch (e) {
        await ctx.step("packaging", "failed", 1);
        throw e;
      }

      if (await ctx.isCancelled()) throw new Error("cancelled");

      // --- publishing: run the store upload inline. The deployments row is
      // created here so the same upload is visible on the Deployments page
      // (logs piped to both). Only present when auto-deploy was selected. ---
      if (ctx.build.autoDeployDestinationId) {
        await ctx.step("publishing", "running");
        try {
          await runInlinePublish(ctx, artifacts);
          await ctx.step("publishing", "success", 0);
        } catch (e) {
          await ctx.step("publishing", "failed", 1);
          throw e;
        }
      }

      // --- cleanup (best-effort; ignore failures) ---
      await ctx.step("cleanup", "running");
      try {
        await run(`bash -lc ${shq(`rm -rf ${shq(`${remoteDir}/node_modules`)} ${shq(`${remoteDir}/android/.gradle`)}`)}`);
      } catch {
        /* ignore */
      }
      await ctx.step("cleanup", "success", 0);

      return { artifacts };
      } catch (err) {
        if (abortCtl.signal.aborted) {
          await ctx.log("Cancellation: killing remote build processes…");
          await killRemoteBuildProcs();
        }
        throw err;
      } finally {
        clearInterval(cancelPoll);
      }
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
  if (cert.appId !== ctx.build.appId) throw new Error("Signing certificate does not belong to this app.");
  if (cert.platform !== "android") throw new Error(`Selected signing certificate is for ${cert.platform}, not Android.`);
  if (cert.kind !== "keystore") throw new Error(`Selected signing certificate must be a keystore (got kind=${cert.kind}).`);

  const certsDir = `${remoteDir}/certs/google`;
  await execDrained(ssh, `mkdir -p ${shq(certsDir)}`, "mkdir keystore dir", 15_000);

  // Re-sanitize fileName at the point of use. The upload validator rejects
  // path traversal, but legacy rows that pre-date that validator could still
  // hold unsafe values; without `safeBasename` an attacker-controlled
  // fileName could escape `certsDir` (and the value baked into
  // ANDROID_KEYSTORE would point outside the workspace bind-mount).
  const safeKeystoreFileName = safeBasename(cert.fileName, "keystore fileName");
  const remotePath = `${certsDir}/${safeKeystoreFileName}`;
  const blobBase64 = decryptString(cert.fileBlobEnc);
  const sizeKb = Math.round((blobBase64.length * 3) / 4 / 1024);
  await ctx.log(`Uploading keystore (~${sizeKb} KB) -> ${remotePath}`);
  await uploadBase64(ssh, { base64: blobBase64, remotePath, label: "keystore", decoder: "linux" });
  await ctx.log(`Materialized keystore: ${safeKeystoreFileName}`);

  const meta = (cert.metadata ?? {}) as Record<string, string>;
  const password = cert.passwordEnc ? decryptString(cert.passwordEnc) : "";
  const flags = [
    `-e ${shq(`ANDROID_KEYSTORE=/workspace/certs/google/${safeKeystoreFileName}`)}`,
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

/**
 * Build an error message that carries the actual failure (output tail) instead
 * of the bash wrapping. Without this the UI's error banner just shows
 * "command failed (exit 1): bash -lc 'export …'" while the real cause sits
 * buried in the streamed logs.
 */
function formatCmdError(cmd: string, exitCode: number, outputTail: string): string {
  const summary = cmd.split("\n")[0]?.slice(0, 80) ?? "";
  const tail = outputTail.trim();
  if (!tail) return `Command failed (exit ${exitCode}): ${summary}`;
  return `Command failed (exit ${exitCode}): ${summary}\n${tail}`;
}
