---
name: Follow-ups from the store-destinations / auto-deploy feature
description: Open follow-ups left after wiring the Destinations section into the build-start flow and rewriting the Add Destination dialog (2026-05-11). Pick these up when revisiting deployments.
type: project
originSessionId: 5fe582f1-8e2d-4a8d-8eb2-9aa620d1d5d0
---
Three open follow-ups left over from the 2026-05-11 store-destinations + auto-deploy work:

**1. Destination edit UI is gone.** The dialog rewrite (apps/web/src/routes/StoreDestinationsPage.tsx) only supports creating, not editing. The old dialog had an "edit" entry path but Save was always disabled in that mode, so the rewrite dropped it.
- *Why:* dropped to keep the rewrite focused; PATCH endpoint for destinations doesn't exist either.
- *How to apply:* re-add the editing branch to `DestDialog`, add a PATCH `/destinations/:id` route in `apps/api/src/routes/deployments.ts` that re-encrypts the config when supplied, and wire it through `api.client.ts`.

**2. Google Play `artifactKind` (AAB vs APK) isn't actually respected by the runner.** The destination dialog now saves `config.artifactKind` ("aab" | "apk"), but `apps/api/src/worker/runners/googlePlayRunner.ts` still picks based on what artifacts the build produced.
- *Why:* the schema/UI piece landed first; runner update is a separate change.
- *How to apply:* in `GooglePlayUploadRunner`, read `cfg.artifactKind` and prefer `artifactByKind(ctx.build, [cfg.artifactKind])`. Fall back to the other kind only if the preferred is missing, with a clear `ctx.log` warning.

**3. ~~Build page (BuildPage.tsx) doesn't show the auto-queued deployment inline.~~ RESOLVED 2026-05-13.** Auto-deploy no longer queues a separate job — the publishing phase runs the upload inline via `runInlinePublish` and the resulting deployments row appears in the existing `showDeployment` DetailRow on BuildPage. See [[inline-publish-design]].
