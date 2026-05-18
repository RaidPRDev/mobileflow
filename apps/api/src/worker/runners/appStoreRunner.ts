import { Client } from "ssh2";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { certificates } from "../../db/schema.js";
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
    const auth = parseAppStoreAuth(ctx.config as Record<string, unknown>);

    await ctx.log(`App Store upload (${auth.mode}) via altool: ${target.username}@${target.host}`);
    await ctx.log(`Artifact URL: ${ipa.url}`);
    await logDestinationDiagnostics(ctx, auth);
    await logSigningDiagnostics(ctx, auth);

    await withSsh(target, async (ssh) => {
      // altool needs a local file on the Mac. The IPA was published to the
      // Linux artifact host by macRunner (the Mac build sandbox may be gone
      // by the time a deploy retries), so fetch it back over HTTPS.
      const tmpDir = `/tmp/altool-${ctx.build.id}`;
      const ipaPath = `${tmpDir}/${fileName}`;
      await ctx.log(`Downloading IPA onto Mac: ${ipaPath}`);
      const dl = await exec(
        ssh,
        `bash -lc ${shq(
          `set -e; mkdir -p ${shq(tmpDir)} && ` +
          `curl -fSL --retry 3 --retry-delay 2 -o ${shq(ipaPath)} ${shq(ipa.url)} && ` +
          `test -s ${shq(ipaPath)}`,
        )}`,
        (line) => ctx.log(line),
      );
      if (dl.exitCode !== 0) throw new Error(`Failed to fetch IPA onto Mac from ${ipa.url}`);

      try {
        // We pass --output-format json so altool dumps a structured response
        // (including underlying Apple errors with status/detail/code) on
        // stdout. Plain altool only prints a terse top-level message — that's
        // why Fastlane wrappers seem to give "more output": they also use
        // structured mode and pretty-print the inner errors.
        if (auth.mode === "api_key") {
          await ctx.log(`Writing ASC API key (id=${auth.keyId})…`);
          await writeFileOverSsh(ssh, "~/.appstoreconnect/private_keys", `AuthKey_${auth.keyId}.p8`, auth.privateKeyP8);
          const cmd =
            `xcrun altool --upload-app --type ios --file ${shq(ipaPath)} ` +
            `--apiKey ${shq(auth.keyId)} --apiIssuer ${shq(auth.issuerId)} --output-format json`;
          await ctx.log(`$ xcrun altool --upload-app --type ios --file <ipa> --apiKey <KEY_ID> --apiIssuer <ISSUER> --output-format json`);
          const cap = captureAltoolOutput(ctx);
          const r = await exec(ssh, `bash -lc ${shq(cmd)}`, cap.onLine);
          // Best-effort: shred the key after upload regardless of success.
          await exec(ssh, `bash -lc ${shq(`rm -f ~/.appstoreconnect/private_keys/AuthKey_${auth.keyId}.p8`)}`, () => {});
          await handleAltoolResult(ctx, r.exitCode, cap.getStdout(), cap.getStderr());
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
          args.push("--output-format", "json");
          const cmd = `xcrun altool ${args.join(" ")}`;
          await ctx.log(`$ xcrun altool --upload-app --type ios --file <ipa> -u <APPLE_ID> -p @stdin${auth.appAppleId ? " --apple-id <APP_APPLE_ID>" : ""}${auth.teamId ? " --team-id <TEAM_ID>" : ""} --output-format json`);
          const cap = captureAltoolOutput(ctx);
          const r = await execWithStdin(ssh, `bash -lc ${shq(cmd)}`, auth.appSpecificPassword + "\n", cap.onLine);
          await handleAltoolResult(ctx, r.exitCode, cap.getStdout(), cap.getStderr());
        }
      } finally {
        await exec(ssh, `bash -lc ${shq(`rm -rf ${shq(tmpDir)}`)}`, () => {});
      }
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

/**
 * Dumps the resolved destination credentials to the deploy log so the user
 * can verify nothing's mistyped (e.g. wrong Team ID, missing dashes in the
 * app-specific password, swapped Apple ID / App Apple ID fields). Secrets
 * (the password and the .p8) are never printed in full — only a structural
 * fingerprint so it can be compared against a known-good value.
 */
async function logDestinationDiagnostics(ctx: DeployContext, auth: AppStoreAuth): Promise<void> {
  await ctx.log("Destination config:");
  await ctx.log(`  destination: ${ctx.destination.name} (${ctx.destination.id})`);
  await ctx.log(`  type: ${ctx.destination.type}`);
  await ctx.log(`  bundleId: ${ctx.destination.bundleId ?? "(none)"}`);
  await ctx.log(`  authMode: ${auth.mode}`);
  if (auth.mode === "altool") {
    await ctx.log(`  appleId: ${auth.appleId}`);
    await ctx.log(`  appAppleId: ${auth.appAppleId ?? "(none)"}`);
    await ctx.log(`  teamId: ${auth.teamId ?? "(none)"}`);
    await ctx.log(`  appSpecificPassword: ${fingerprintPassword(auth.appSpecificPassword)}`);
    if (!auth.appAppleId) {
      await ctx.log("  ! warning: appAppleId is empty — altool may fail to resolve the team for this app");
    }
  } else {
    await ctx.log(`  issuerId: ${auth.issuerId}`);
    await ctx.log(`  keyId: ${auth.keyId}`);
    await ctx.log(`  privateKeyP8: ${fingerprintP8(auth.privateKeyP8)}`);
  }
}

function fingerprintPassword(pw: string): string {
  const len = pw.length;
  const trimmed = pw.trim();
  const dashShape = /^[a-zA-Z]{4}-[a-zA-Z]{4}-[a-zA-Z]{4}-[a-zA-Z]{4}$/.test(trimmed);
  const generalShape = /^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/.test(trimmed);
  const dashCount = (trimmed.match(/-/g) || []).length;
  const flags: string[] = [];
  if (len !== trimmed.length) flags.push("has surrounding whitespace");
  if (dashShape) flags.push("matches xxxx-xxxx-xxxx-xxxx ✓");
  else if (generalShape) flags.push("matches xxxx-xxxx-xxxx-xxxx (alphanumeric)");
  else flags.push(`unexpected shape (${dashCount} dashes)`);
  // First + last char help identify which password without exposing it.
  const ends = trimmed.length >= 2 ? `${trimmed[0]}…${trimmed[trimmed.length - 1]}` : "(too short)";
  return `${len} chars, ends ${ends}, ${flags.join("; ")}`;
}

/**
 * Loads the .p12 + provisioning profile used to sign this build and emits a
 * side-by-side check against the destination. The cert + profile metadata
 * (commonName, teamId, bundleId, provision UUID) is populated at upload time
 * by `routes/certificates.ts`, so this is just a read + format step.
 *
 * Apple's altool "Could not determine provider" / "not a team of which you
 * are a member" errors almost always come down to a mismatch between the
 * team that signed the build and the Apple ID account running the upload.
 * Logging both sides up front makes that diagnosable in one glance.
 */
async function logSigningDiagnostics(ctx: DeployContext, auth: AppStoreAuth): Promise<void> {
  const certId = ctx.build.certificateId;
  if (!certId) {
    await ctx.log("  ! warning: build has no signing certificate recorded — skipping signing diagnostics");
    return;
  }
  const [p12] = await db.select().from(certificates).where(eq(certificates.id, certId)).limit(1);
  if (!p12) {
    await ctx.log(`  ! warning: signing certificate ${certId} not found in DB`);
    return;
  }
  const profiles = await db
    .select()
    .from(certificates)
    .where(and(eq(certificates.parentCertId, p12.id), eq(certificates.kind, "provisioning")))
    .orderBy(asc(certificates.createdAt));
  const prov = profiles[0];
  const p12Meta = (p12.metadata ?? {}) as Record<string, string>;
  const provMeta = (prov?.metadata ?? {}) as Record<string, string>;

  // Apple's signing-identity CN looks like "iPhone Distribution: Name (TEAM)";
  // the team in parens is what actually ends up on the binary.
  const cn = p12Meta.commonName ?? "(unknown)";
  const teamFromCn = cn.match(/\(([A-Z0-9]+)\)\s*$/)?.[1] ?? null;

  await ctx.log("Signing diagnostics:");
  await ctx.log(`  .p12: ${p12.fileName}`);
  await ctx.log(`    commonName: ${cn}`);
  if (teamFromCn) await ctx.log(`    team (from CN): ${teamFromCn}`);
  if (!prov) {
    await ctx.log("  ! provisioning profile: none attached");
    return;
  }
  await ctx.log(`  provisioning profile: ${prov.fileName}`);
  await ctx.log(`    uuid:     ${provMeta.provisionId ?? "(missing)"}`);
  await ctx.log(`    teamId:   ${provMeta.teamId ?? "(missing)"}`);
  await ctx.log(`    bundleId: ${provMeta.bundleId ?? "(missing)"}`);
  if (profiles.length > 1) {
    await ctx.log(`    ! ${profiles.length} profiles attached to this .p12 — using oldest. Others: ${profiles.slice(1).map((p) => p.fileName).join(", ")}`);
  }

  // Cross-checks. Only meaningful for altool mode; api_key uploads don't
  // pass a team-id and resolve the provider from the .p8 instead.
  if (auth.mode === "altool") {
    const checkTeam = auth.teamId || null;
    if (checkTeam && provMeta.teamId) {
      const match = checkTeam === provMeta.teamId;
      await ctx.log(`  cross-check: destination teamId ${checkTeam} vs profile teamId ${provMeta.teamId} ${match ? "✓" : "✗ MISMATCH"}`);
      if (!match) {
        await ctx.log("    Apple will reject the upload — altool expects the destination team to own the signing identity.");
      }
    } else if (!checkTeam) {
      await ctx.log("  ! destination has no teamId set — altool may fall back to the wrong team for this Apple ID");
    }
    if (teamFromCn && provMeta.teamId && teamFromCn !== provMeta.teamId) {
      await ctx.log(`  ! signing identity team (${teamFromCn}) and profile team (${provMeta.teamId}) disagree — the .p12 and .mobileprovision are from different teams`);
    }
  }
}

function fingerprintP8(p8: string): string {
  const len = p8.length;
  const hasBegin = /-----BEGIN PRIVATE KEY-----/.test(p8);
  const hasEnd = /-----END PRIVATE KEY-----/.test(p8);
  const flags: string[] = [];
  flags.push(hasBegin ? "BEGIN header ✓" : "BEGIN header MISSING");
  flags.push(hasEnd ? "END footer ✓" : "END footer MISSING");
  return `${len} chars, ${flags.join("; ")}`;
}

/**
 * Output handler for altool runs. Streams stderr lines to the deploy log
 * (progress and human-readable error messages) and silently accumulates
 * stdout (the structured JSON document from --output-format json). We hide
 * stdout from the user because the pretty-printed JSON is large and noisy;
 * we summarise it ourselves on exit. We also retain stderr text so we can
 * fall back to pattern-matching it when altool fails before producing JSON.
 */
function captureAltoolOutput(ctx: DeployContext): {
  onLine: (line: string) => void;
  getStdout: () => string;
  getStderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    onLine: (line) => {
      if (line.startsWith("! ")) {
        stderr += line.slice(2) + "\n";
        void ctx.log(line);
      } else {
        stdout += line + "\n";
      }
    },
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function handleAltoolResult(
  ctx: DeployContext,
  exitCode: number,
  stdoutJson: string,
  stderr: string,
): Promise<void> {
  if (exitCode === 0) {
    await ctx.log("Upload accepted by App Store Connect.");
    return;
  }
  // Two failure shapes:
  //  - Upload-stage errors (Apple rejects the IPA after auth succeeds) print
  //    a JSON document on stdout with product-errors[]. We walk that.
  //  - Auth-stage errors (bad password, missing contracts, account locked)
  //    exit before --output-format json takes effect; stdout is empty and
  //    the only signal is stderr. We pattern-match known error codes to
  //    give the user something actionable.
  const parsed = tryParseJson(stdoutJson);
  let lines: string[] = parsed ? summarizeAltoolErrors(parsed) : [];
  if (lines.length === 0) lines = interpretAltoolStderr(stderr);
  for (const line of lines) await ctx.log(`! ${line}`);
  const reason =
    (parsed ? pickShortReason(parsed) : null) ||
    pickKnownStderrReason(stderr) ||
    null;
  throw new Error(`altool failed (exit ${exitCode})${reason ? ": " + reason : ""}`);
}

// Stderr signatures we know how to translate. Anything we don't recognise
// just relies on the raw stderr lines that already streamed to the log.
function interpretAltoolStderr(stderr: string): string[] {
  const hints: string[] = [];
  if (/Code=-22938/.test(stderr) || /Sign in with the app-specific password/i.test(stderr)) {
    hints.push("Apple rejected the app-specific password.");
    hints.push("Generate a fresh one at account.apple.com → Sign-In and Security → App-Specific Passwords, then Edit this destination and paste it back in (with dashes).");
  }
  if (/required contracts/i.test(stderr) || /Code=-19241/.test(stderr)) {
    hints.push("Apple Developer agreements are not signed.");
    hints.push("Account holder must accept them at appstoreconnect.apple.com → Business → Agreements, Tax, and Banking.");
  }
  if (/Could not determine provider public id/i.test(stderr) && hints.length === 0) {
    hints.push("Apple could not resolve which team owns this app.");
    hints.push("Verify the Apple ID is a member of the team that owns the App Apple ID, and that all App Store Connect agreements are accepted.");
  }
  return hints;
}

function pickKnownStderrReason(stderr: string): string | null {
  if (/Code=-22938/.test(stderr)) return "Apple rejected the app-specific password";
  if (/required contracts/i.test(stderr) || /Code=-19241/.test(stderr)) return "Required Apple Developer agreements not signed";
  if (/Could not determine provider public id/i.test(stderr)) return "Apple could not resolve the team for this app";
  return null;
}

function tryParseJson(s: string): unknown {
  const trimmed = s.trim();
  if (!trimmed) return null;
  // altool occasionally prepends a non-JSON banner before the JSON body —
  // tolerate that by trying from the first '{' if a plain parse fails.
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const i = trimmed.indexOf("{");
  if (i > 0) {
    try { return JSON.parse(trimmed.slice(i)); } catch { /* give up */ }
  }
  return null;
}

function summarizeAltoolErrors(root: unknown): string[] {
  const out: string[] = [];
  const errors = collectErrors(root);
  if (!errors.length) return out;
  out.push("altool reported the following errors:");
  for (const e of errors) walkError(e, "  ", out);
  return out;
}

// altool has used several key names for the error array across Xcode
// versions; check all of them.
const ERROR_KEYS = ["product-errors", "productErrors", "tool-errors", "errors"];

function collectErrors(root: unknown): unknown[] {
  if (!isObject(root)) return [];
  for (const k of ERROR_KEYS) {
    const v = root[k];
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

function walkError(err: unknown, indent: string, out: string[]): void {
  if (!isObject(err)) return;
  const msg = pickString(err, "message", "detail", "NSLocalizedDescription");
  const status = err["status"];
  const code = err["code"];
  const bits: string[] = [];
  if (msg) bits.push(msg);
  if (status != null) bits.push(`status ${String(status)}`);
  if (code != null) bits.push(`code ${String(code)}`);
  if (bits.length) out.push(indent + bits.join(" — "));
  const userInfo = err["userInfo"];
  if (isObject(userInfo)) {
    const desc = pickString(userInfo, "NSLocalizedDescription");
    if (desc && desc !== msg) out.push(indent + desc);
    const under = userInfo["NSUnderlyingError"];
    if (under) walkError(under, indent + "  ", out);
  }
  const underlying = err["underlyingErrors"];
  if (Array.isArray(underlying)) {
    for (const u of underlying) walkError(u, indent + "  ", out);
  }
}

function pickShortReason(root: unknown): string | null {
  const errs = collectErrors(root);
  if (!errs.length) return null;
  const first = errs[0];
  if (!isObject(first)) return null;
  const inner = isObject(first["userInfo"]) ? (first["userInfo"]["NSUnderlyingError"] as unknown) : null;
  const innerMsg = isObject(inner) ? pickString(inner, "detail", "message", "NSLocalizedDescription") : null;
  return innerMsg || pickString(first, "message", "detail", "NSLocalizedDescription") || null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}
