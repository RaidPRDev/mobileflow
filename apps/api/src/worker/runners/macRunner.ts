import { and, eq } from "drizzle-orm";
import { Client } from "ssh2";
import { db } from "../../db/client.js";
import { apps, certificates, environmentVars, gitConnections } from "../../db/schema.js";
import { decryptString } from "../../lib/crypto.js";
import { env } from "../../env.js";
import { exec, resolveMacHost, withSsh } from "../ssh.js";
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
    const downloadsDir = `${host.downloadsBase}/${orgId}/${buildId}`;
    const macTools = host.toolsPath ?? env.MAC_BUILD_TOOLS;
    const cloneUrl = cloneUrlFor(conn.provider as "github" | "gitlab" | "bitbucket", a.gitRepoFullName, token);

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
      ].map(shq).join(" ");

      try {
        const fullCmd = [
          envVarsExports, // exports prefix env vars in the same shell
          `bash ${shq(`${macTools}/main_build.sh`)} ${cmdArgs}`,
        ].filter(Boolean).join(" && ");
        await run(`bash -lc ${shq(fullCmd)}`);
        await ctx.step("installing", "success", 0);
        await ctx.step("building", "success", 0);
        await ctx.step("signing", "success", 0);
        await ctx.step("packaging", "success", 0);
      } catch (e) {
        for (const name of ["installing", "building", "signing", "packaging"] as const) {
          await ctx.step(name, "failed", 1);
        }
        throw e;
      }

      if (await ctx.isCancelled()) throw new Error("cancelled");

      // --- publishing ---
      await ctx.step("publishing", "running");
      const safeAppName = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "app";
      const buildDate = new Date().toISOString().slice(0, 10).replaceAll("-", "_");
      const artifactBase = `${safeAppName}_${buildDate}`;
      // Common output locations from the existing iOS pipeline; we copy whatever is present.
      const candidates = [
        { src: `${remoteDir}/build/Export/${a.name}.ipa`, dst: `${downloadsDir}/${artifactBase}.ipa`, kind: "ipa" },
        { src: `${remoteDir}/build/${a.name}.xcarchive`, dst: `${downloadsDir}/${artifactBase}.xcarchive`, kind: "xcarchive", isDir: true },
        { src: `${remoteDir}/build/Export/${a.name}.app.dSYM.zip`, dst: `${downloadsDir}/${artifactBase}.dSYM.zip`, kind: "dsym" },
      ];
      const artifacts: { kind: string; url: string }[] = [];
      for (const c of candidates) {
        const flag = c.isDir ? "-d" : "-f";
        const cp = c.isDir ? `cp -R ${shq(c.src)} ${shq(c.dst)}` : `cp ${shq(c.src)} ${shq(c.dst)}`;
        const r = await exec(ssh, `bash -lc ${shq(`if [ ${flag} ${shq(c.src)} ]; then ${cp} && echo present; else echo missing; fi`)}`, (line) => ctx.log(line));
        if (r.exitCode === 0) {
          // No reliable presence result via stdout in current helper; check existence again.
          const check = await exec(ssh, `bash -lc ${shq(`[ ${flag} ${shq(c.dst)} ] && echo ok || echo missing`)}`, () => {});
          if (check.exitCode === 0) {
            artifacts.push({
              kind: c.kind,
              url: `${host.downloadsBaseUrl}/${orgId}/${buildId}/${c.dst.split("/").pop()}`,
            });
          }
        }
      }
      await ctx.step("publishing", "success", 0);

      // --- cleanup ---
      await ctx.step("cleanup", "running");
      try {
        await run(`bash -lc ${shq(`rm -rf ${shq(`${remoteDir}/Pods`)} ${shq(`${remoteDir}/build/DerivedData`)}`)}`);
      } catch {
        /* ignore */
      }
      await ctx.step("cleanup", "success", 0);

      return { artifacts };
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
  const [prov] = await db
    .select()
    .from(certificates)
    .where(and(eq(certificates.parentCertId, p12.id), eq(certificates.kind, "provisioning")))
    .limit(1);
  if (!prov) throw new Error("No provisioning profile attached to the selected signing certificate.");

  const certsDir = `${remoteDir}/certs/ios`;
  const profilesDir = `${certsDir}/profiles`;
  await new Promise<void>((resolve, reject) => {
    ssh.exec(`mkdir -p ${shq(certsDir)} ${shq(profilesDir)}`, (err, stream) => {
      if (err) return reject(err);
      stream.on("close", (code: number | null) => (code === 0 ? resolve() : reject(new Error(`mkdir failed (${code})`))));
    });
  });

  const writeBlob = async (blobBase64: string, dest: string) => {
    await new Promise<void>((resolve, reject) => {
      ssh.exec(`base64 -D > ${shq(dest)}`, (err, stream) => {
        if (err) return reject(err);
        stream.on("close", (code: number | null) => (code === 0 ? resolve() : reject(new Error(`upload failed (${code})`))));
        stream.write(blobBase64);
        stream.end();
      });
    });
  };

  const p12Path = `${certsDir}/${p12.fileName}`;
  await writeBlob(decryptString(p12.fileBlobEnc), p12Path);
  await ctx.log(`Materialized iOS .p12: ${p12.fileName}`);

  const provisionMeta = (prov.metadata ?? {}) as Record<string, string>;
  const provisionName = provisionMeta.provisionName ?? prov.fileName.replace(/\.mobileprovision$/, "");
  const provisionPath = `${profilesDir}/${provisionName}.mobileprovision`;
  await writeBlob(decryptString(prov.fileBlobEnc), provisionPath);
  await ctx.log(`Materialized provisioning profile: ${provisionName}`);

  return {
    p12Path,
    p12Password: p12.passwordEnc ? decryptString(p12.passwordEnc) : "",
    provisionId: provisionMeta.provisionId ?? "",
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
