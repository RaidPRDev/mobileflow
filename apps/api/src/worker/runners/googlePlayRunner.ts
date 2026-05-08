import { JWT } from "google-auth-library";
import { artifactByKind, type DeployContext, type DeployRunner } from "../deployRunner.js";

/**
 * Uploads an .aab (preferred) or .apk to Google Play via the Publisher API.
 *
 * Required `destination.bundleId` (= packageName) and `destination.config`:
 *   - serviceAccountJson: full service-account JSON string
 *
 * Optional `destination.trackOrChannel`: defaults to "internal".
 *
 * Edit lifecycle:
 *   1. POST .../edits           → editId
 *   2. POST .../bundles (or .../apks) with the binary → versionCode
 *   3. PATCH .../tracks/<track> → assign versionCode to the track
 *   4. POST .../edits/<id>:commit
 */
export class GooglePlayUploadRunner implements DeployRunner {
  async run(ctx: DeployContext): Promise<void> {
    const cfg = ctx.config as { serviceAccountJson?: string };
    if (!cfg.serviceAccountJson) throw new Error("Destination config missing serviceAccountJson");
    const packageName = ctx.destination.bundleId;
    if (!packageName) throw new Error("Destination is missing bundleId / packageName");
    const track = ctx.destination.trackOrChannel || "internal";

    const aabOrApk = artifactByKind(ctx.build, ["aab", "apk"]);
    if (!aabOrApk) throw new Error("Build has no .aab or .apk artifact to upload");
    const isAab = aabOrApk.kind === "aab";

    let parsed: { client_email: string; private_key: string };
    try {
      parsed = JSON.parse(cfg.serviceAccountJson) as { client_email: string; private_key: string };
    } catch {
      throw new Error("serviceAccountJson is not valid JSON");
    }
    if (!parsed.client_email || !parsed.private_key) throw new Error("Service account JSON missing client_email/private_key");

    const jwt = new JWT({
      email: parsed.client_email,
      key: parsed.private_key,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
    await ctx.log(`Authenticating as ${parsed.client_email}…`);
    const accessToken = (await jwt.getAccessToken()).token;
    if (!accessToken) throw new Error("Failed to obtain Google access token");

    const baseUrl = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
    const uploadBase = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
    const headers = { authorization: `Bearer ${accessToken}` };

    // 1. Create an edit.
    await ctx.log("Creating Play Console edit…");
    const editRes = await fetch(`${baseUrl}/edits`, { method: "POST", headers });
    if (!editRes.ok) throw new Error(`edits.insert failed: ${editRes.status} ${await editRes.text()}`);
    const editId = ((await editRes.json()) as { id: string }).id;
    await ctx.log(`Edit ${editId} created.`);

    // 2. Fetch the artifact (the artifact host serves it publicly as <downloadsBaseUrl>/<orgId>/<buildId>/<file>).
    await ctx.log(`Downloading artifact: ${aabOrApk.url}`);
    const artRes = await fetch(aabOrApk.url);
    if (!artRes.ok) throw new Error(`Could not download artifact: ${artRes.status}`);
    const buf = Buffer.from(await artRes.arrayBuffer());
    await ctx.log(`Downloaded ${buf.length.toLocaleString()} bytes.`);

    // 3. Upload to bundles or apks.
    const uploadUrl = `${uploadBase}/edits/${editId}/${isAab ? "bundles" : "apks"}?uploadType=media`;
    const contentType = isAab ? "application/octet-stream" : "application/vnd.android.package-archive";
    await ctx.log(`Uploading ${isAab ? ".aab" : ".apk"} to Google Play…`);
    const upRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { ...headers, "content-type": contentType },
      body: buf,
    });
    if (!upRes.ok) throw new Error(`upload failed: ${upRes.status} ${await upRes.text()}`);
    const upJson = (await upRes.json()) as { versionCode?: number };
    if (!upJson.versionCode) throw new Error("upload response missing versionCode");
    const versionCode = upJson.versionCode;
    await ctx.log(`Uploaded versionCode ${versionCode}.`);

    // 4. Assign versionCode to the requested track.
    await ctx.log(`Assigning versionCode ${versionCode} to track "${track}"…`);
    const trackRes = await fetch(`${baseUrl}/edits/${editId}/tracks/${encodeURIComponent(track)}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        track,
        releases: [{ status: "completed", versionCodes: [String(versionCode)] }],
      }),
    });
    if (!trackRes.ok) throw new Error(`tracks.update failed: ${trackRes.status} ${await trackRes.text()}`);

    // 5. Commit.
    await ctx.log("Committing edit…");
    const commitRes = await fetch(`${baseUrl}/edits/${editId}:commit`, { method: "POST", headers });
    if (!commitRes.ok) throw new Error(`edits.commit failed: ${commitRes.status} ${await commitRes.text()}`);
    await ctx.log("Google Play edit committed.");
  }
}
