---
name: Follow-up — extract provisionId at .mobileprovision upload time
description: Open follow-up to make the certificates upload route extract and persist metadata.provisionId (the profile UUID) so future iOS builds don't rely on the macRunner regex fallback.
type: project
originSessionId: 5fe582f1-8e2d-4a8d-8eb2-9aa620d1d5d0
---
Follow-up task the user wants to come back to: when a `.mobileprovision` is uploaded via `POST /orgs/:orgId/certificates` (apps/api/src/routes/certificates.ts), the server should parse the embedded plist and persist `metadata.provisionId` (the profile UUID) on the certificates row. Today the upload only stores whatever metadata the client sends — the existing profile in the DB has `metadata.provisionName` but no `provisionId`, and that broke iOS builds because `main_build.sh` requires PROVISION_ID as a positional arg.

**Why:** Surfaced 2026-05-11 while debugging an iOS build that failed at `main_build.sh` with "Missing required parameters." A workaround was added in `apps/api/src/worker/runners/macRunner.ts` (`extractProvisionUuid` regex on the CMS-signed profile bytes) so existing rows still build. The user wants the upload flow itself fixed so fresh uploads don't need the runner-side fallback.

**How to apply:**
- Update the POST handler in `apps/api/src/routes/certificates.ts` to, when `kind === "provisioning"`, parse the buffer for `<key>UUID</key><string>...</string>` and write it into the persisted `metadata.provisionId` (merging with any client-supplied metadata, not overwriting other keys).
- Same idea for PATCH when `fileBase64` is being replaced.
- Reuse the same regex approach as `extractProvisionUuid` in macRunner.ts (or extract to a shared helper in `apps/api/src/lib/` and call from both places).
- Once upload backfills metadata reliably, the macRunner fallback can stay as defense-in-depth or be removed.
- Consider a one-off backfill query/script for already-uploaded profiles missing `metadata.provisionId`.
