---
name: inline-publish-design
description: "Auto-deploy uploads run inline as the build's \"publishing\" phase, sharing one deployments row between the build pipeline view and the Deployments page — not a separate queued job."
metadata: 
  node_type: memory
  type: project
  originSessionId: bef39c0d-8a74-4fed-ac2d-0d95aad78d79
---

When a build is started with `autoDeployDestinationId` set (Destinations toggle ON on NewBuildPage), the store upload runs **inline** during the build's `publishing` phase, not as a separate queued deployment.

**The single source of truth:** `apps/api/src/worker/inlinePublish.ts` → `runInlinePublish(ctx, artifacts)`. Called from both `linuxDocker.ts` and `macRunner.ts` at the end of their pipelines. It:
1. Inserts a `deployments` row with `status="running"` (skipping the queue, so deployWorker won't double-pick it).
2. Invokes the same runner the deployWorker would (`pickDeployRunner(dest)` → `AppStoreUploadRunner`/`GooglePlayUploadRunner`).
3. Pipes each log line into BOTH the build's `logText` and the deployment's `logText` — so the user sees the same upload progress in the BuildPage pipeline view AND in the DeploymentsPage row's log modal. They are literally the same record.
4. Updates the deployment row to `success`/`failed` when done.

**Why:** user spec (this session) — "we should upload the binary within the pipeline, but we can also see it in the deployment page, its tied together". The earlier "queue the deployment" model created a separate post-build job and required the user to switch screens to watch progress; the inline model surfaces it in the pipeline tracker AND keeps the historical record on the deployments page.

**How to apply:**
- Don't add a parallel "queue then poll" path for auto-deploy. If you find yourself reaching for `deployments(status='queued')` in the build runner, you're going against this design.
- The deployWorker (apps/api/src/worker/deployWorker.ts) still exists — it now only handles **manually-triggered** deployments (Deploy-binary button on BuildPage, or "New deployment" composer on DeploymentsPage). Both go through `POST /apps/:appId/deployments` which inserts `status="queued"`.
- `maybeQueueAutoDeploy` in worker.ts has a "skip if a deployments row already exists for this build" guard — this preserves the legacy queue path for StubRunner / web fallback. Don't remove the guard or you'll get duplicate deployments when real runners are in use.
- Phase list is conditional: `phasesFor(target, hasAutoDeploy)` in `routes/builds.ts` only includes `"publishing"` for iOS/Android when a destination is selected. If you re-add `"publishing"` unconditionally, the phase will sit "pending" forever for builds without auto-deploy.
- Destinations UI gating: iOS shows the section only when `buildType === "appstore"`; Android only when `buildType === "release"`. Web has no destinations.

Related: [[project_store_destinations_followups]] (item #3 there about "BuildPage doesn't show auto-queued deployment inline" is now obsolete — the inline deployment row is visible via the existing `showDeployment` DetailRow on BuildPage).
