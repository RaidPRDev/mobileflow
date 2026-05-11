import { Client } from "ssh2";
import { exec, resolveMacHost, withSsh } from "../ssh.js";
import { artifactByKind, fileNameFromUrl, type DeployContext, type DeployRunner } from "../deployRunner.js";

/**
 * Uploads an .ipa to App Store Connect from the Mac build host. Supports two
 * auth modes (selected by `destination.config.authMode`):
 *
 *   "api_key" — App Store Connect API .p8 key (modern):
 *     { authMode: "api_key", issuerId, keyId, privateKeyP8 }
 *
 *   "altool" — legacy Apple ID + app-specific password:
 *     { authMode: "altool", appleId, appSpecificPassword, appAppleId?, teamId? }
 *
 * If `authMode` is omitted we infer from the keys present (backward compat
 * with existing destinations created before this field existed).
 */
export class AppStoreUploadRunner implements DeployRunner {
  async run(ctx: DeployContext): Promise<void> {
    const target = await resolveMacHost();
    if (!target) throw new Error("Mac build host is not configured (needed for App Store upload)");

    const ipa = artifactByKind(ctx.build, ["ipa"]);
    if (!ipa) throw new Error("Build has no .ipa artifact to upload");

    const fileName = fileNameFromUrl(ipa.url);
    const ipaPath = `${target.downloadsBase}/${ctx.app.orgId}/${ctx.build.id}/${fileName}`;
    const auth = parseAppStoreAuth(ctx.config as Record<string, unknown>);

    await ctx.log(`App Store upload (${auth.mode}) via altool: ${target.username}@${target.host}`);
    await ctx.log(`Artifact: ${ipaPath}`);

    await withSsh(target, async (ssh) => {
      const presence = await exec(ssh, `bash -lc ${shq(`[ -f ${shq(ipaPath)} ] && echo present || echo missing`)}`, () => {});
      if (presence.exitCode !== 0) throw new Error(`IPA not found on Mac host: ${ipaPath}`);

      if (auth.mode === "api_key") {
        await ctx.log(`Writing ASC API key (id=${auth.keyId})…`);
        await writeFileOverSsh(ssh, "~/.appstoreconnect/private_keys", `AuthKey_${auth.keyId}.p8`, auth.privateKeyP8);
        const cmd = `xcrun altool --upload-app --type ios --file ${shq(ipaPath)} --apiKey ${shq(auth.keyId)} --apiIssuer ${shq(auth.issuerId)}`;
        await ctx.log(`$ xcrun altool --upload-app --type ios --file <ipa> --apiKey <KEY_ID> --apiIssuer <ISSUER>`);
        const r = await exec(ssh, `bash -lc ${shq(cmd)}`, (line) => ctx.log(line));
        // Best-effort: shred the key after upload regardless of success.
        await exec(ssh, `bash -lc ${shq(`rm -f ~/.appstoreconnect/private_keys/AuthKey_${auth.keyId}.p8`)}`, () => {});
        if (r.exitCode !== 0) throw new Error(`altool failed (exit ${r.exitCode})`);
      } else {
        // altool reads the password from stdin when -p @stdin is passed. We
        // never spell the password into the command line.
        const args = [
          "--upload-app",
          "--type", "ios",
          "--file", shq(ipaPath),
          "-u", shq(auth.appleId),
          "-p", "@stdin",
        ];
        if (auth.appAppleId) args.push("--apple-id", shq(auth.appAppleId));
        if (auth.teamId) args.push("--team-id", shq(auth.teamId));
        const cmd = `xcrun altool ${args.join(" ")}`;
        await ctx.log(`$ xcrun altool --upload-app --type ios --file <ipa> -u <APPLE_ID> -p @stdin${auth.appAppleId ? " --apple-id <APP_APPLE_ID>" : ""}${auth.teamId ? " --team-id <TEAM_ID>" : ""}`);
        const r = await execWithStdin(ssh, `bash -lc ${shq(cmd)}`, auth.appSpecificPassword + "\n", (line) => ctx.log(line));
        if (r.exitCode !== 0) throw new Error(`altool failed (exit ${r.exitCode})`);
      }
      await ctx.log("Upload accepted by App Store Connect.");
    });
  }
}

type AppStoreAuth =
  | { mode: "api_key"; issuerId: string; keyId: string; privateKeyP8: string }
  | { mode: "altool"; appleId: string; appSpecificPassword: string; appAppleId?: string; teamId?: string };

function parseAppStoreAuth(cfg: Record<string, unknown>): AppStoreAuth {
  const mode = typeof cfg.authMode === "string" ? cfg.authMode : inferMode(cfg);
  if (mode === "api_key") {
    const issuerId = strOrEmpty(cfg.issuerId);
    const keyId = strOrEmpty(cfg.keyId);
    const privateKeyP8 = strOrEmpty(cfg.privateKeyP8);
    if (!issuerId || !keyId || !privateKeyP8) {
      throw new Error("Destination config (api_key) missing one of: issuerId, keyId, privateKeyP8");
    }
    return { mode, issuerId, keyId, privateKeyP8 };
  }
  if (mode === "altool") {
    const appleId = strOrEmpty(cfg.appleId);
    const appSpecificPassword = strOrEmpty(cfg.appSpecificPassword);
    if (!appleId || !appSpecificPassword) {
      throw new Error("Destination config (altool) missing one of: appleId, appSpecificPassword");
    }
    const appAppleId = strOrEmpty(cfg.appAppleId) || undefined;
    const teamId = strOrEmpty(cfg.teamId) || undefined;
    return { mode, appleId, appSpecificPassword, appAppleId, teamId };
  }
  throw new Error(`Unknown App Store authMode: ${mode}`);
}

function inferMode(cfg: Record<string, unknown>): "api_key" | "altool" {
  if (cfg.privateKeyP8 || cfg.keyId || cfg.issuerId) return "api_key";
  return "altool";
}

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function writeFileOverSsh(ssh: Client, dirPath: string, fileName: string, contents: string): Promise<void> {
  const dest = `${dirPath}/${fileName}`;
  await new Promise<void>((resolve, reject) => {
    ssh.exec(
      `bash -lc ${shq(`mkdir -p ${shq(dirPath)} && chmod 700 ${shq(dirPath)} && cat > ${shq(dest)} && chmod 600 ${shq(dest)}`)}`,
      (err, stream) => {
        if (err) return reject(err);
        let stderr = "";
        stream.on("data", () => {});
        stream.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
        stream.on("close", (code: number | null) =>
          code === 0 ? resolve() : reject(new Error(`write ${dest} failed (${code}): ${stderr.trim().slice(0, 200)}`)),
        );
        stream.write(contents);
        stream.end();
      },
    );
  });
}

async function execWithStdin(
  ssh: Client,
  cmd: string,
  stdin: string,
  onLine: (line: string) => void,
): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    ssh.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let outBuf = "";
      let errBuf = "";
      const flush = (buf: string, isErr: boolean) => {
        const lines = buf.split(/\r?\n/);
        const tail = lines.pop() ?? "";
        for (const line of lines) if (line) onLine(isErr ? `! ${line}` : line);
        return tail;
      };
      stream.on("data", (c: Buffer) => { outBuf = flush(outBuf + c.toString("utf8"), false); });
      stream.stderr.on("data", (c: Buffer) => { errBuf = flush(errBuf + c.toString("utf8"), true); });
      stream.on("close", (code: number | null) => {
        if (outBuf) onLine(outBuf);
        if (errBuf) onLine(`! ${errBuf}`);
        resolve({ exitCode: code ?? -1 });
      });
      stream.on("error", reject);
      stream.write(stdin);
      stream.end();
    });
  });
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
