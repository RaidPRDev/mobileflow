import { and, eq, gte, isNotNull, isNull, ne, or } from "drizzle-orm";
import { Client } from "ssh2";
import { db } from "../../db/client.js";
import { apps, buildStacks, builds, certificates, environmentVars, gitConnections } from "../../db/schema.js";
import { decryptString } from "../../lib/crypto.js";
import { env } from "../../env.js";
import { exec, execDrained, resolveLinuxHost, resolveMacHost, uploadBase64, withSsh } from "../ssh.js";
import { runInlinePublish } from "../inlinePublish.js";
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

    // Resolve the Xcode developer dir from the build's stack so xcodebuild /
    // xcrun / pod pick up the right toolchain. We export DEVELOPER_DIR rather
    // than running `sudo xcode-select -s` so the switch is scoped to this
    // build process and doesn't require passwordless sudo on the Mac.
    const [stack] = ctx.build.stackId
      ? await db.select().from(buildStacks).where(eq(buildStacks.id, ctx.build.stackId)).limit(1)
      : [];
    const developerDir = stack?.image ? xcodeDeveloperDir(stack.image) : null;
    if (developerDir) {
      await ctx.log(`Xcode (stack ${ctx.build.stackId}): DEVELOPER_DIR=${developerDir}`);
    } else if (ctx.build.stackId) {
      await ctx.log(`Stack ${ctx.build.stackId} has no image — using system default Xcode`);
    }

    return await withSsh(host, async (ssh) => {
      // Single AbortController shared across every exec() in this run. When
      // ctx.isCancelled() flips, we abort, which closes the active SSH channel
      // and propagates SIGHUP to the remote shell + its children (xcodebuild,
      // pod, etc.). Without this the cancellation only fires at phase
      // boundaries — a long xcodebuild step could keep going for many seconds
      // after the user hit Cancel.
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

      // Wipe the entire build dir. Used as the error-path cleanup so a failed
      // build doesn't leave a half-cloned repo / partial Pods install behind.
      // Uses a fresh channel (no abort signal) — even when we're aborting we
      // still want this cleanup to run to completion.
      const wipeBuildDir = async () => {
        try {
          await exec(ssh, `bash -lc ${shq(`rm -rf ${shq(remoteDir)}`)}`, (line) => ctx.log(line));
        } catch {
          /* best-effort */
        }
      };

      // Belt-and-suspenders: after the channel is closed by abort, any process
      // that detached from the shell (cocoapods has a daemon, xcodebuild can
      // outlive its bash parent in rare cases) won't get HUP'd. A fresh
      // channel running pkill scoped to the build's working directory kills
      // anything still touching it. Best-effort, short timeout.
      const killRemoteBuildProcs = async () => {
        try {
          await execDrained(
            ssh,
            `bash -lc ${shq(`pkill -f ${shq(buildId)} 2>/dev/null || true`)}`,
            "cancel-pkill",
            5_000,
          );
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
        cert = await materializeIosCerts(ssh, remoteDir, ctx);
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

      // Phase tracking. main_build.sh / build_ios_app.sh emit
      // `[MFPHASE] <name> <status>` markers around their major sections; we
      // intercept those in the line stream and call ctx.step() in real time.
      // `lastRunning` lets the catch block mark the failing phase precisely.
      const SUB_PHASES = ["installing", "building", "signing", "packaging"] as const;
      type SubPhase = (typeof SUB_PHASES)[number];
      const PHASE_RE = /^\[MFPHASE\]\s+(\w+)\s+(\w+)(?:\s+(\-?\d+))?\s*$/;
      let lastRunning: SubPhase | null = "installing"; // already-running before main_build.sh starts
      const phaseSucceeded = new Set<SubPhase>();

      try {
        // CocoaPods (Ruby) needs a UTF-8 locale; non-interactive SSH sessions
        // don't inherit LANG/LC_ALL from the user's profile, so `pod install`
        // hits "Unicode Normalization not appropriate for ASCII-8BIT" without
        // these. Set first so user-supplied env vars can still override.
        const localeExports = `export LANG=en_US.UTF-8 && export LC_ALL=en_US.UTF-8`;
        // globals.sh requires MAC_SERVER_USER/IP/PASS via `${VAR:?}` strict
        // expansion. These are only consumed by the legacy build_deploy.sh
        // (App Store upload), which MobileFlow never invokes — but the strict
        // check fires at globals.sh load time anyway. Inject sane values from
        // the resolved Mac host so non-interactive sessions don't blow up.
        const serverExports = [
          `export MAC_SERVER_USER=${shq(host.username)}`,
          `export MAC_SERVER_IP=${shq(host.host)}`,
          `export MAC_SERVER_PORT=${shq(String(host.port))}`,
          `export MAC_SERVER_PASS=${shq("unused-by-mobileflow")}`,
        ].join(" && ");
        // DEVELOPER_DIR comes from the build's stack and picks the Xcode used
        // by xcodebuild/xcrun/pod inside this shell. Declared before user env
        // vars so a per-environment override is still possible if needed.
        const xcodeExport = developerDir ? `export DEVELOPER_DIR=${shq(developerDir)}` : "";
        const fullCmd = [
          localeExports,
          xcodeExport,
          serverExports,
          envVarsExports, // user env vars take precedence (declared after)
          `bash ${shq(`${macTools}/main_build.sh`)} ${cmdArgs}`,
        ].filter(Boolean).join(" && ");
        const buildCmd = `bash -lc ${shq(fullCmd)}`;

        // Custom line handler: parse phase markers, otherwise stream to log.
        // "packaging" is special: the script's "packaging success" marker means
        // the .ipa is built, but our packaging phase also includes the scp
        // copy to the downloads server. We suppress the script-side packaging
        // success so it stays "running" until scp finishes below.
        const onBuildLine = (line: string) => {
          const m = PHASE_RE.exec(line);
          if (m) {
            const name = m[1]!;
            const status = m[2]!;
            const code = m[3] ? Number(m[3]) : undefined;
            if ((SUB_PHASES as readonly string[]).includes(name)) {
              const phase = name as SubPhase;
              if (status === "running") lastRunning = phase;
              else if (status === "success") {
                phaseSucceeded.add(phase);
                if (lastRunning === phase) lastRunning = null;
              }
              const isPackagingSuccess = phase === "packaging" && status === "success";
              if (!isPackagingSuccess) {
                void ctx.step(phase, status as "running" | "success" | "failed" | "skipped", code);
              }
            }
            return; // marker line itself isn't useful in the build log
          }
          void ctx.log(line);
        };

        const r = await exec(ssh, buildCmd, onBuildLine, abortCtl.signal);
        if (abortCtl.signal.aborted) {
          throw new Error("cancelled");
        }
        if (r.exitCode !== 0) {
          throw new Error(formatCmdError(buildCmd, r.exitCode, r.outputTail));
        }
        // Belt-and-suspenders: if a script forgets to emit a phase's success
        // marker but the overall command exited 0, we mark sub-phases done.
        // "packaging" is intentionally excluded here — we close it ourselves
        // after the scp-to-downloads step below.
        for (const p of SUB_PHASES) {
          if (p === "packaging") continue;
          if (!phaseSucceeded.has(p)) await ctx.step(p, "success", 0);
        }
        lastRunning = null;
      } catch (e) {
        // Mark whichever phase was last "running" as the failure point; skip
        // anything after it. This makes the UI show the right phase as the
        // failed one instead of always blaming "installing".
        const failed: SubPhase = lastRunning ?? "installing";
        await ctx.step(failed, "failed", 1);
        const idx = SUB_PHASES.indexOf(failed);
        for (let i = idx + 1; i < SUB_PHASES.length; i++) {
          await ctx.step(SUB_PHASES[i]!, "skipped");
        }
        throw e;
      }

      if (await ctx.isCancelled()) throw new Error("cancelled");

      // --- packaging (continued): scp artifacts to the Linux downloads box so
      // they're at a stable URL. Mac disks are small; we push artifacts
      // straight to xbuilds.raidpr.com using scp *from the Mac* (not
      // Mac->API->Linux — that double-hop through WSL was ~17 KB/s on a home
      // uplink). The Linux SSH key is pre-installed on the Mac at
      // ~/.ssh/raidx_linux_key. ---
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
      await ctx.step("packaging", "success", 0);

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
        if (abortCtl.signal.aborted) {
          // Cancellation path: kill remote processes first so they release
          // file handles before we wipe — xcodebuild can otherwise keep dirs
          // un-removable on some macOS configs.
          await ctx.log("Cancellation: killing remote build processes…");
          await killRemoteBuildProcs();
        } else {
          // Pipeline failure: blow away the entire build dir so we don't pile
          // up half-cloned repos / partial Pods / orphaned DerivedData.
          await ctx.log("Build failed — cleaning up remote build directory.");
        }
        await wipeBuildDir();
        await wipeXcArtifacts();
        throw err;
      } finally {
        clearInterval(cancelPoll);
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
  if (p12.appId !== ctx.build.appId) throw new Error("Signing certificate does not belong to this app.");
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
    await uploadBase64(ssh, { base64: blobBase64, remotePath: dest, label, decoder: "mac" });
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
  // The certificates upload route extracts this from the .mobileprovision and
  // persists it on metadata, so it is always present for valid uploads.
  const provisionId = provisionMeta.provisionId ?? "";
  if (!provisionId) {
    throw new Error(
      "Provisioning profile UUID missing from metadata. Re-upload the .mobileprovision.",
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
 * Translate a stack's `image` value into the DEVELOPER_DIR path
 * that Xcode tools read. Accepts three input shapes so admins can pick what
 * they're comfortable with:
 *
 *   1. Absolute path ending in `/Contents/Developer` — used verbatim.
 *   2. Absolute path to an `.app` bundle — `/Contents/Developer` appended.
 *   3. A short tag like `xcode-25.6` / `Xcode-25.6` / `25.6` — expanded to
 *      `/Applications/Xcode_<version>.app/Contents/Developer`.
 *
 * Returns null if the input is empty.
 */
function xcodeDeveloperDir(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith("/")) {
    return v.endsWith("/Contents/Developer") ? v : `${v}/Contents/Developer`;
  }
  const version = v.replace(/^xcode[-_]?/i, "");
  return `/Applications/Xcode_${version}.app/Contents/Developer`;
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

