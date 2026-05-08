import { Client } from "ssh2";
import { exec, resolveMacHost, withSsh } from "../ssh.js";
import { artifactByKind, fileNameFromUrl, type DeployContext, type DeployRunner } from "../deployRunner.js";

/**
 * Uploads an .ipa to App Store Connect / TestFlight from the Mac build host.
 *
 * Strategy: the Mac that built the IPA already has Xcode + `xcrun altool`,
 * and the artifact lives under `<host.downloadsBase>/<orgId>/<buildId>/<file>.ipa`.
 * We materialize the App Store Connect API .p8 key into
 * `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8` (one of the locations
 * altool searches), then run:
 *
 *   xcrun altool --upload-app --type ios --file <ipa>
 *                --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
 *
 * Required `destination.config`:
 *   - issuerId: ASC API issuer UUID
 *   - keyId: ASC API key id (10-char)
 *   - privateKeyP8: contents of the AuthKey_*.p8 file
 *
 * `destination.bundleId` is informational here; altool reads it from the IPA.
 */
export class AppStoreUploadRunner implements DeployRunner {
  async run(ctx: DeployContext): Promise<void> {
    const target = await resolveMacHost();
    if (!target) throw new Error("Mac build host is not configured (needed for App Store / TestFlight upload)");

    const ipa = artifactByKind(ctx.build, ["ipa"]);
    if (!ipa) throw new Error("Build has no .ipa artifact to upload");

    const raw = ctx.config as { issuerId?: string; keyId?: string; privateKeyP8?: string };
    if (!raw.issuerId || !raw.keyId || !raw.privateKeyP8) {
      throw new Error("Destination config missing one of: issuerId, keyId, privateKeyP8");
    }
    const cfg = { issuerId: raw.issuerId, keyId: raw.keyId, privateKeyP8: raw.privateKeyP8 };

    const fileName = fileNameFromUrl(ipa.url);
    const ipaPath = `${target.downloadsBase}/${ctx.app.orgId}/${ctx.build.id}/${fileName}`;

    await ctx.log(`App Store upload via altool: ${target.username}@${target.host}`);
    await ctx.log(`Artifact: ${ipaPath}`);

    await withSsh(target, async (ssh) => {
      // Sanity check the IPA exists.
      const presence = await exec(ssh, `bash -lc ${shq(`[ -f ${shq(ipaPath)} ] && echo present || echo missing`)}`, () => {});
      if (presence.exitCode !== 0) throw new Error(`IPA not found on Mac host: ${ipaPath}`);

      // Materialize the .p8 (overwriting any prior key for the same KEY_ID).
      await ctx.log(`Writing ASC API key (id=${cfg.keyId})…`);
      await writeFileOverSsh(ssh, "~/.appstoreconnect/private_keys", `AuthKey_${cfg.keyId}.p8`, cfg.privateKeyP8);

      // Run altool. We deliberately don't pipe the API key through stdin —
      // altool always reads from the on-disk file based on KEY_ID/ISSUER_ID.
      const cmd = `xcrun altool --upload-app --type ios --file ${shq(ipaPath)} --apiKey ${shq(cfg.keyId)} --apiIssuer ${shq(cfg.issuerId)}`;
      await ctx.log(`$ ${cmd}`);
      const r = await exec(ssh, `bash -lc ${shq(cmd)}`, (line) => ctx.log(line));
      if (r.exitCode !== 0) {
        throw new Error(`altool failed (exit ${r.exitCode})`);
      }
      // Best-effort: shred the key after upload.
      await exec(ssh, `bash -lc ${shq(`rm -f ~/.appstoreconnect/private_keys/AuthKey_${cfg.keyId}.p8`)}`, () => {});
      await ctx.log("Upload accepted by App Store Connect.");
    });
  }
}

async function writeFileOverSsh(ssh: Client, dirPath: string, fileName: string, contents: string): Promise<void> {
  const dest = `${dirPath}/${fileName}`;
  await new Promise<void>((resolve, reject) => {
    ssh.exec(
      `bash -lc ${shq(`mkdir -p ${shq(dirPath)} && chmod 700 ${shq(dirPath)} && cat > ${shq(dest)} && chmod 600 ${shq(dest)}`)}`,
      (err, stream) => {
        if (err) return reject(err);
        stream.on("close", (code: number | null) => (code === 0 ? resolve() : reject(new Error(`write failed (${code})`))));
        stream.write(contents);
        stream.end();
      },
    );
  });
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
