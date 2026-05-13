---
name: ios-pipeline-overhaul-2026-05-12
description: "iOS build pipeline rewritten on 2026-05-12 — Xcode 26.5 upgrade on Mac runner, artifacts now go Mac→Linux direct (not Mac→API→Linux), full per-build cleanup with phase signaling"
metadata: 
  node_type: memory
  type: project
  originSessionId: 23bea99c-6ff4-49f2-9860-1cdebb575e3a
---

On 2026-05-12 we overhauled the iOS build pipeline end-to-end. Key facts that affect future work:

- **Xcode 26.5 is installed on the Mac runner** (replaced 18). Disk is 59GB — small. Required: `xcodebuild -downloadPlatform iOS` once (8.5GB; bundles SDK+simulator together — cannot install device support without simulator runtime). `build_ios_app.sh` now requires `-destination 'generic/platform=iOS'` on `-showBuildSettings` (Xcode 26 enforces this).

- **Artifacts ship Mac → Linux directly via scp** (not Mac → API server → Linux). The Linux key (`raidpr_com_cloud_key`) is pre-installed on the Mac at `~/.ssh/raidx_linux_key` (mode 600), Linux host pre-trusted via `~/.ssh/known_hosts`. **Why:** Mac→API→Linux streaming via `pipeBetweenSsh` measured ~17 KB/s — the WSL2 networking layer + double SSH encryption + Node single-threaded stream shuffling killed throughput. Direct scp gets normal Mac-uplink speeds. **How to apply:** if anything wants to send big files between Mac and Linux, do it on the Mac side using `~/.ssh/raidx_linux_key`, not through the API.

- **Mac is treated as ephemeral storage.** Every build wipes `Clients/<orgId>/<buildId>/` entirely on success AND failure. Worker startup runs `sweepMacBuildSandboxes()` (in `apps/api/src/worker/maintenance.ts`) which also clears legacy `DerivedData/{App-*,Pods-*}` and `$TMPDIR/*.xcdistributionlogs`/`ResultBundle_*.xcresult` — these are safe to wipe at startup because no builds are running. Per-build `$TMPDIR` cleanup is gated by a "did any other build overlap our window?" DB check — skips when concurrent builds were active. **How to apply:** never write build state to the Mac expecting it to persist; always assume the dir is gone after the build ends.

- **`build_ios_app.sh` uses `-derivedDataPath "$BUILD_DIR/DerivedData"`** so DerivedData lives inside the build sandbox and dies with it. Exception: the Pods `xcodebuild build -target` invocation cannot accept `-derivedDataPath` (Xcode requires `-scheme`); Pods DerivedData goes to `~/Library/Developer/Xcode/DerivedData/Pods-*` and gets caught by the startup sweep.

- **Phase signaling via `[MFPHASE] <name> <status>` markers.** Scripts emit these around major sections; `macRunner.ts` parses them from the log stream and calls `ctx.step()` in real time. `lastRunning` is tracked so the catch block marks the right phase failed (instead of always blaming `installing`). The `mf_phase` helper lives in `globals.sh`.

- **macRunner injects `MAC_SERVER_USER/IP/PORT/PASS` env vars** before invoking `main_build.sh` because `globals.sh` uses `${VAR:?}` strict expansion on those (consumed only by the legacy `build_deploy.sh` App Store upload path that MobileFlow never invokes, but the check fires at load time).

- **Mac tools at `/Users/Rafael/RaidX/Tools/` are NOT pulled from git per build.** They live on the Mac as standalone scripts. After editing anything under `infra/tools/RaidX/Tools/ios/` in the repo, scp the file to the Mac before retesting. There is no auto-sync. See [[follow_up_mac_tools_auto_sync]] (not yet written) for the deferred work to fix this.

Build flow phases as the UI shows them: `preparing` (git clone) → `installing` (deps+keychain+Capacitor sync) → `building` (xcodebuild archive) → `signing` (xcodebuild -exportArchive) → `packaging` (IPA assembly, brief) → `publishing` (scp to Linux) → `cleanup` (rm Mac sandbox + per-build $TMPDIR cleanup).
