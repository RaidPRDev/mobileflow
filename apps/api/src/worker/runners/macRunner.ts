import { and, eq, gte, isNotNull, isNull, ne, or } from "drizzle-orm";
import { Client } from "ssh2";
import { db } from "../../db/client.js";
import { apps, builds, certificates, environmentVars, gitConnections } from "../../db/schema.js";
import { decryptString } from "../../lib/crypto.js";
import { env } from "../../env.js";
import { exec, resolveLinuxHost, resolveMacHost, withSsh } from "../ssh.js";
import { cloneUrlFor } from "../gitClone.js";
import type { Runner, RunnerContext } from "../runner.js";

/**
 * Ports `References/XBuildApi/xbuild/uploadAndBuildiOS.sh` to the in-process
 * worker over SSH key auth (no sshpass / no plaintext password).
 *
 * Differences from the reference:
 *   - Repo cloned on the Mac via the org's stored git OAuth token, not
 *     uploaded as a zip from the local CLI.
 *   - All parameters passed as args to `main_build.sh` (matches the existing
 *     positional contract: MODE, CLIENT_ID, BUILD_ID, P12_PATH, P12_PASSWORD,
 *     PROVISION_ID, PROVISION_PATH, PROVISION_NAME).
 *   - Logs streamed line-by-line into the build view.
 *
 * Required on the Mac:
 *   - `git`, `xcodebuild`, `pod`, `security`, `xcrun` for the build script
 *   - `MAC_BUILD_TOOLS/main_build.sh` matching the existing iOS pipeline
 *   - SSH key in `authorized_keys` for `MAC_BUILD_USER`
 */
export class MacRunner implements Runner {
  async run(ctx: RunnerContext): Promise<{ artifacts: { kind: string; url: string; sizeBytes?: number }[] }> {
    if (ctx.build.target !== "ios") throw new Error("MacRunner only handles target=ios");
    const host = await resolveMacHost();
    if (!host) throw new Error("Mac build host is not configured");
    await ctx.log(`Mac host (${host.source}): ${host.username}@${host.host}:${host.port}`);

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
    const macTools = host.toolsPath ?? env.MAC_BUILD_TOOLS;
    const cloneUrl = cloneUrlFor(conn.provider as "github" | "gitlab" | "bitbucket", a.gitRepoFullName, token);

    return await withSsh(host, async (ssh) => {
      const run = async (cmd: string) => {
        const r = await exec(ssh, cmd, (line) => ctx.log(line));
        if (r.exitCode !== 0) throw new Error(formatCmdError(cmd, r.exitCode, r.outputTail));
      };

      // Wipe the entire build dir. Used as the error-path cleanup so a failed
      // build doesn't leave a half-cloned repo / partial Pods install behind.
      const wipeBuildDir = async () => {
        try {
          await exec(ssh, `bash -lc ${shq(`rm -rf ${shq(remoteDir)}`)}`, (line) => ctx.log(line));
        } catch {
          /* best-effort */
        }
      };

      // Captured before main_build.sh runs; used to scope per-build cleanup of
      // xcdistributionlogs/xcresult dirs in the user temp dir (xcodebuild has
      // no flag to redirect those out of $TMPDIR). See wipeXcArtifacts below.
      const buildStartUnix = Math.floor(Date.now() / 1000);

      // /var/folders cleanup, gated by concurrency. Only safe to delete files
      // newer than our build start if no OTHER build ran concurrently — else
      // we might wipe their artifacts. When we skip, the startup sweep will
      // catch the leftovers on the next API restart.
      const wipeXcArtifacts = async () => {
        try {
          const ourStart = new Date(buildStartUnix * 1000);
          // Builds (other than ours) whose [startedAt, finishedAt] overlapped
          // with our window: started before now AND (still running OR finished
          // after our start).
          const concurrent = await db
            .select({ id: builds.id })
            .from(builds)
            .where(
              and(
                ne(builds.id, buildId),
                isNotNull(builds.startedAt),
                or(isNull(builds.finishedAt), gte(builds.finishedAt, ourStart)),
              ),
            )
            .limit(1);
          if (concurrent.length > 0) {
            await ctx.log("[cleanup] skipped xc artifact cleanup — concurrent build(s) active during this window");
            return;
          }
          const cmd =
            `find "$TMPDIR" -maxdepth 1 ` +
            `\\( -name "*.xcdistributionlogs" -o -name "ResultBundle_*.xcresult" \\) ` +
            `-newermt "@${buildStartUnix}" -exec rm -rf {} + 2>/dev/null; ` +
            `echo done`;
          await exec(ssh, `bash -lc ${shq(cmd)}`, () => {});
          await ctx.log("[cleanup] wiped xcdistributionlogs/xcresult from this build window");
        } catch (e) {
          await ctx.log(`[cleanup] xc artifact cleanup failed (non-fatal): ${(e as Error).message}`);
        }
      };

      try {
      // --- preparing ---
      await ctx.step("preparing", "running");
      try {
        await run(`mkdir -p ${shq(remoteDir)}`);
        await ctx.log(`Cloning ${a.gitRepoFullName} @ ${ctx.build.commitSha.slice(0, 7)}`);
        await run(`bash -lc ${shq(`set -e; cd ${shq(remoteDir)} && git init -q && git remote add origin ${shq(cloneUrl)} && git fetch --depth 1 origin ${shq(ctx.build.commitSha)} && git checkout -q FETCH_HEAD`)}`);
        await ctx.step("preparing", "success", 0);
      } catch (e) {
        await ctx.step("preparing", "failed", 1);
        throw e;
      }

      if (await ctx.isCancelled()) throw new Error("cancelled");

      // --- installing + building + signing + packaging (handled by main_build.sh) ---
      await ctx.step("installing", "running");
      let cert: IosCertMaterials;
      try {
        cert = await materializeIosCerts(ssh, orgId, remoteDir, ctx);
      } catch (e) {
        await ctx.log(`Signing certificate error: ${e instanceof Error ? e.message : String(e)}`);
        await ctx.step("installing", "failed", 1);
        throw e;
      }
      const envVarsExports = await collectEnvExports(ctx);

      const cmdArgs = [
        env.isProd ? "build" : "dev", // MODE — keeps backward-compat with the reference script
        orgId, // CLIENT_ID
        buildId, // BUILD_ID
        cert.p12Path,
        cert.p12Password,
        cert.provisionId,
        cert.provisionPath,
        cert.provisionName,
        // UPLOAD_AFTER_BUILD — always "no". App Store uploads are governed by
        // the user's Destination toggle and run via the deployWorker against a
        // configured StoreDestination (see worker.ts:maybeQueueAutoDeploy).
        // The script used to upload unconditionally with hardcoded creds,
        // which ignored the user's choice.
        "no",
      ].map(shq).join(" ");

      try {
        // CocoaPods (Ruby) needs a UTF-8 locale; non-interactive SSH sessions
        // don't inherit LANG/LC_ALL from the user's profile, so `pod install`
        // hits "Unicode Normalization not appropriate for ASCII-8BIT" without
        // these. Set first so user-supplied env vars can still override.
        const localeExports = `export LANG=en_US.UTF-8 && export LC_ALL=en_US.UTF-8`;
        const fullCmd = [
          localeExports,
          envVarsExports, // user env vars take precedence (declared after)
          `bash ${shq(`${macTools}/main_build.sh`)} ${cmdArgs}`,
        ].filter(Boolean).join(" && ");
        await run(`bash -lc ${shq(fullCmd)}`);
        await ctx.step("installing", "success", 0);
        await ctx.step("building", "success", 0);
        await ctx.step("signing", "success", 0);
        await ctx.step("packaging", "success", 0);
      } catch (e) {
        // installing/building/signing/packaging are bundled inside one
        // main_build.sh invocation, so we cannot tell which sub-phase failed
        // without instrumenting that script. Mark the entry phase as failed
        // and the rest as skipped — better than lying about all four failing.
        await ctx.step("installing", "failed", 1);
        for (const name of ["building", "signing", "packaging"] as const) {
          await ctx.step(name, "skipped");
        }
        throw e;
      }

      if (await ctx.isCancelled()) throw new Error("cancelled");

      // --- publishing ---
      // Mac disks are small; we push artifacts straight to the Linux box
      // (xbuilds.raidpr.com) using scp *from the Mac* (not Mac->API->Linux —
      // that double-hop through WSL was ~17 KB/s on a home uplink). The Linux
      // SSH key is pre-installed on the Mac at ~/.ssh/raidx_linux_key.
      await ctx.step("publishing", "running");
      const linuxHost = await resolveLinuxHost();
      if (!linuxHost) throw new Error("Linux build host is not configured — set LINUX_BUILD_* in env or add a build_hosts row");

      const safeAppName = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "app";
      const buildDate = new Date().toISOString().slice(0, 10).replaceAll("-", "_");
      const artifactBase = `${safeAppName}_${buildDate}`;

      // build_ios_app.sh writes to ${remoteDir}/ios/build/{ipa/App.ipa,App.xcarchive}.
      // The dSYM lives inside the xcarchive at dSYMs/. Zip them so each artifact
      // is a single file scp can push.
      const macBuildDir = `${remoteDir}/ios/build`;
      const macIpa = `${macBuildDir}/ipa/App.ipa`;
      const macArchiveZip = `${macBuildDir}/App.xcarchive.zip`;
      const macDsymZip = `${macBuildDir}/App.dSYM.zip`;

      await ctx.log("Zipping xcarchive and dSYMs on the Mac…");
      await run(
        `bash -lc ${shq(
          `set -e; ` +
          `[ -f ${shq(macIpa)} ] || { echo "missing IPA at ${macIpa}" >&2; exit 1; }; ` +
          `[ -d ${shq(`${macBuildDir}/App.xcarchive`)} ] || { echo "missing xcarchive at ${macBuildDir}/App.xcarchive" >&2; exit 1; }; ` +
          `cd ${shq(macBuildDir)} && rm -f App.xcarchive.zip App.dSYM.zip && ` +
          `zip -qr App.xcarchive.zip App.xcarchive && ` +
          `cd App.xcarchive && zip -qr ${shq(macDsymZip)} dSYMs`,
        )}`,
      );

      // SSH options for Mac -> Linux. Key was pre-installed; host pre-trusted
      // via ssh-keyscan, so StrictHostKeyChecking=yes is safe.
      const linuxDir = `${linuxHost.downloadsBase}/${orgId}/${buildId}`;
      const linuxTarget = `${linuxHost.username}@${linuxHost.host}`;
      const macLinuxKey = "~/.ssh/raidx_linux_key";
      const sshOpts = `-i ${macLinuxKey} -o StrictHostKeyChecking=yes -o ServerAliveInterval=30`;

      // Create the remote directory on Linux (idempotent).
      await run(
        `bash -lc ${shq(
          `ssh -p ${linuxHost.port} ${sshOpts} ${linuxTarget} ${shq(`mkdir -p ${shq(linuxDir)}`)}`,
        )}`,
      );

      const specs = [
        { kind: "ipa", srcPath: macIpa, dstName: `${artifactBase}.ipa` },
        { kind: "xcarchive", srcPath: macArchiveZip, dstName: `${artifactBase}.xcarchive.zip` },
        { kind: "dsym", srcPath: macDsymZip, dstName: `${artifactBase}.dSYM.zip` },
      ];

      const artifacts: { kind: string; url: string; sizeBytes?: number }[] = [];
      for (const s of specs) {
        const dstPath = `${linuxDir}/${s.dstName}`;
        await ctx.log(`scp ${s.kind}: ${s.srcPath} -> ${linuxHost.host}:${dstPath}`);
        // Run scp on the Mac. -q suppresses progress (the Mac stderr would be
        // a control-char mess in our log); we log the size+throughput ourselves.
        // The trailing block verifies the bytes landed intact: a successful scp
        // can still write a truncated file if the connection drops at the wrong
        // moment, so we compare local stat (-f %z on macOS) against remote stat
        // (-c %s on Linux) over the same key.
        const cmd =
          `set -e; ` +
          `t0=$(date +%s); ` +
          `scp -q -P ${linuxHost.port} ${sshOpts} ${shq(s.srcPath)} ${linuxTarget}:${shq(dstPath)}; ` +
          `local_sz=$(stat -f %z ${shq(s.srcPath)}); ` +
          `remote_sz=$(ssh -p ${linuxHost.port} ${sshOpts} ${linuxTarget} ${shq(`stat -c %s ${shq(dstPath)}`)}); ` +
          `if [ "$local_sz" != "$remote_sz" ]; then echo "size mismatch: local=$local_sz remote=$remote_sz" >&2; exit 1; fi; ` +
          `secs=$(( $(date +%s) - t0 )); [ $secs -lt 1 ] && secs=1; ` +
          `mb=$(awk "BEGIN { printf \\"%.1f\\", $local_sz/1048576 }"); ` +
          `rate=$(awk "BEGIN { printf \\"%.1f\\", $local_sz/1048576/$secs }"); ` +
          `echo "  ${s.kind}: $mb MB in ${'$'}{secs}s (${'$'}rate MB/s) — ${'$'}local_sz bytes"`;
        await run(`bash -lc ${shq(cmd)}`);
        artifacts.push({
          kind: s.kind,
          url: `${linuxHost.downloadsBaseUrl}/${orgId}/${buildId}/${s.dstName}`,
          // sizeBytes left undefined; could be parsed from the log line above if
          // we end up needing it in builds.artifacts JSON.
        });
      }
      await ctx.step("publishing", "success", 0);

      // --- cleanup ---
      // Artifacts now live on the Linux box; the Mac copy is no longer needed.
      // Wipe the entire build dir + the xc artifacts in $TMPDIR.
      await ctx.step("cleanup", "running");
      try {
        await run(`bash -lc ${shq(`rm -rf ${shq(remoteDir)}`)}`);
      } catch {
        /* best-effort */
      }
      await wipeXcArtifacts();
      await ctx.step("cleanup", "success", 0);

      return { artifacts };
      } catch (err) {
        // Pipeline failure: blow away the entire build dir so we don't pile up
        // half-cloned repos / partial Pods / orphaned DerivedData on the Mac.
        await ctx.log("Build failed — cleaning up remote build directory.");
        await wipeBuildDir();
        await wipeXcArtifacts();
        throw err;
      }
    });
  }
}

interface IosCertMaterials {
  p12Path: string;
  p12Password: string;
  provisionId: string;
  provisionPath: string;
  provisionName: string;
}

async function materializeIosCerts(
  ssh: Client,
  orgId: string,
  remoteDir: string,
  ctx: RunnerContext,
): Promise<IosCertMaterials> {
  const certificateId = ctx.build.certificateId;
  if (!certificateId) {
    throw new Error("No signing certificate selected for this build — pick one when starting the build.");
  }
  await ctx.log(`Looking up signing certificate ${certificateId}…`);
  const [p12] = await db
    .select()
    .from(certificates)
    .where(eq(certificates.id, certificateId))
    .limit(1);
  if (!p12) throw new Error(`Signing certificate ${certificateId} not found.`);
  if (p12.orgId !== orgId) throw new Error("Signing certificate does not belong to this app's organization.");
  if (p12.platform !== "ios") throw new Error(`Selected signing certificate is for ${p12.platform}, not iOS.`);
  if (p12.kind !== "p12") throw new Error(`Selected signing certificate must be a .p12 (got kind=${p12.kind}).`);

  // Provisioning profile is the child row linked to this p12 (parentCertId).
  // Multiple are allowed (extensions); we take the first by created_at.
  await ctx.log(`Looking up provisioning profile for ${p12.fileName}…`);
  const [prov] = await db
    .select()
    .from(certificates)
    .where(and(eq(certificates.parentCertId, p12.id), eq(certificates.kind, "provisioning")))
    .limit(1);
  if (!prov) throw new Error("No provisioning profile attached to the selected signing certificate.");

  const certsDir = `${remoteDir}/certs/ios`;
  const profilesDir = `${certsDir}/profiles`;
  await ctx.log(`Creating remote cert dirs: ${certsDir}`);
  await execDrained(ssh, `mkdir -p ${shq(certsDir)} ${shq(profilesDir)}`, "mkdir certs", 15_000);

  const writeBlob = async (blobBase64: string, dest: string, label: string) => {
    const sizeKb = Math.round((blobBase64.length * 3) / 4 / 1024);
    await ctx.log(`Uploading ${label} (~${sizeKb} KB) -> ${dest}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`upload ${label} timed out after 60s`)), 60_000);
      ssh.exec(`base64 -D > ${shq(dest)}`, (err, stream) => {
        if (err) { clearTimeout(timer); return reject(err); }
        let stderrBuf = "";
        stream.on("data", () => {}); // drain stdout
        stream.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf8"); });
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          if (code === 0) return resolve();
          reject(new Error(`upload ${label} failed (exit ${code}): ${stderrBuf.trim().slice(0, 300) || "(no stderr)"}`));
        });
        stream.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
        stream.write(blobBase64);
        stream.end();
      });
    });
  };

  const p12Path = `${certsDir}/${p12.fileName}`;
  await writeBlob(decryptString(p12.fileBlobEnc), p12Path, ".p12");
  await ctx.log(`Materialized iOS .p12: ${p12.fileName}`);

  const provisionBase64 = decryptString(prov.fileBlobEnc);
  const provisionMeta = (prov.metadata ?? {}) as Record<string, string>;
  const provisionName = provisionMeta.provisionName ?? prov.fileName.replace(/\.mobileprovision$/, "");
  const provisionPath = `${profilesDir}/${provisionName}.mobileprovision`;
  await writeBlob(provisionBase64, provisionPath, "provisioning profile");

  // main_build.sh requires the provisioning profile UUID (PROVISION_ID).
  // Prefer the value stored at upload time; fall back to parsing it out of the
  // CMS-signed .mobileprovision (the plist is plaintext inside the envelope).
  let provisionId = provisionMeta.provisionId ?? "";
  if (!provisionId) {
    provisionId = extractProvisionUuid(Buffer.from(provisionBase64, "base64")) ?? "";
    if (provisionId) await ctx.log(`Extracted provisioning UUID from profile: ${provisionId}`);
  }
  if (!provisionId) {
    throw new Error(
      "Provisioning profile UUID not found. Re-upload the .mobileprovision so its UUID is recorded.",
    );
  }
  await ctx.log(`Materialized provisioning profile: ${provisionName} (uuid ${provisionId})`);

  return {
    p12Path,
    p12Password: p12.passwordEnc ? decryptString(p12.passwordEnc) : "",
    provisionId,
    provisionPath,
    provisionName,
  };
}

function extractProvisionUuid(buf: Buffer): string | null {
  const text = buf.toString("latin1");
  const m = text.match(/<key>UUID<\/key>\s*<string>([0-9A-Fa-f-]{36})<\/string>/);
  return m && m[1] ? m[1] : null;
}

async function collectEnvExports(ctx: RunnerContext): Promise<string> {
  if (!ctx.build.environmentId) return "";
  const vars = await db.select().from(environmentVars).where(eq(environmentVars.environmentId, ctx.build.environmentId));
  if (vars.length === 0) return "";
  return vars.map((v) => `export ${v.key}=${shq(decryptString(v.valueEnc))}`).join(" && ");
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Turn a non-zero exit into an error whose message carries the *real* failure
 * (the tail of the command's output) instead of just the bash wrapping. The
 * UI surfaces this verbatim in the error banner.
 */
function formatCmdError(cmd: string, exitCode: number, outputTail: string): string {
  const summary = cmd.split("\n")[0]?.slice(0, 80) ?? "";
  const tail = outputTail.trim();
  if (!tail) return `Command failed (exit ${exitCode}): ${summary}`;
  return `Command failed (exit ${exitCode}): ${summary}\n${tail}`;
}

/**
 * ssh.exec() that always drains stdout+stderr and enforces a timeout. Plain
 * `ssh.exec` with only a "close" listener can hang if the channel has buffered
 * stderr nobody is reading — bit us once in the iOS pipeline.
 */
function execDrained(ssh: Client, cmd: string, label: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    ssh.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stderrBuf = "";
      stream.on("data", () => {}); // drain stdout
      stream.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf8"); });
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        reject(new Error(`${label} failed (exit ${code}): ${stderrBuf.trim().slice(0, 300) || "(no stderr)"}`));
      });
      stream.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    });
  });
}
