import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { builds } from "../db/schema.js";
import { exec, resolveMacHost, withSsh } from "./ssh.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One-shot sweep at worker startup: enumerate Mac build sandboxes under
 * `${remoteBase}/<orgId>/<buildId>/` and wipe any whose build row is in a
 * terminal state (success/failed/canceled) — or doesn't exist at all. The
 * happy-path cleanup already runs at the end of every build; this catches
 * orphans from API crashes, mid-cancel SSH drops, or pre-cleanup-code builds.
 *
 * Best-effort. Logs to console; never throws — a missing Mac shouldn't keep
 * the worker from starting.
 */
export async function sweepMacBuildSandboxes(log: (line: string) => void = console.log): Promise<void> {
  const host = await resolveMacHost();
  if (!host) {
    log("[sweep] mac host not configured; skipping");
    return;
  }

  try {
    await withSsh(host, async (ssh) => {
      // Enumerate <orgId>/<buildId> dirs. -mindepth/maxdepth 2 keeps the
      // search predictable; we filter to UUID-looking names below.
      const cmd = `find ${shq(host.remoteBase)} -mindepth 2 -maxdepth 2 -type d 2>/dev/null`;
      const out: string[] = [];
      const result = await exec(ssh, cmd, (line) => {
        out.push(line);
      });
      if (result.exitCode !== 0) {
        log(`[sweep] find exited ${result.exitCode}: ${result.outputTail.slice(0, 200)}`);
        return;
      }
      const paths = out.map((p) => p.trim()).filter(Boolean);
      const candidates = paths
        .map((p) => ({ path: p, buildId: p.split("/").pop() ?? "" }))
        .filter((c) => UUID_RE.test(c.buildId));

      if (candidates.length === 0) {
        log("[sweep] no candidate dirs found on mac");
        return;
      }

      const ids = candidates.map((c) => c.buildId);
      const active = await db
        .select({ id: builds.id, status: builds.status })
        .from(builds)
        .where(inArray(builds.id, ids));
      const activeMap = new Map(active.map((b) => [b.id, b.status]));

      let kept = 0;
      const toWipe: string[] = [];
      for (const c of candidates) {
        const status = activeMap.get(c.buildId);
        // Keep dirs only for in-flight builds; everything else (terminal or
        // unknown to DB) is orphan and gets wiped.
        if (status === "queued" || status === "running") {
          kept++;
          continue;
        }
        toWipe.push(c.path);
      }

      if (toWipe.length === 0) {
        log(`[sweep] mac sandboxes: ${candidates.length} found, all in-flight — nothing to wipe`);
      } else {
        log(`[sweep] mac sandboxes: ${candidates.length} found, ${kept} in-flight, ${toWipe.length} to wipe`);
        // One rm -rf for everything is faster than per-dir SSH round-trips.
        const rmCmd = `rm -rf ${toWipe.map(shq).join(" ")}`;
        const rm = await exec(ssh, rmCmd, () => {});
        if (rm.exitCode === 0) {
          log(`[sweep] wiped ${toWipe.length} orphan build dir(s) on mac`);
        } else {
          log(`[sweep] rm exited ${rm.exitCode}: ${rm.outputTail.slice(0, 200)}`);
        }
      }

      // Xcode/CoreSimulator cruft that builds leave behind in two shared
      // locations. We can wipe these wholesale at startup because no builds
      // are running yet (worker tick loop hasn't started). The per-build
      // cleanup in macRunner handles new accumulation; this is the floor-reset.
      const sharedCleanup =
        // Stale DerivedData from any pre-`-derivedDataPath` builds. New builds
        // pin DerivedData inside the sandbox, so this only catches legacy.
        `rm -rf ~/Library/Developer/Xcode/DerivedData/App-* ~/Library/Developer/Xcode/DerivedData/Pods-* 2>/dev/null; ` +
        // xcdistributionlogs / xcresult dirs xcodebuild always writes to the
        // user temp dir. No CLI flag exists to redirect these.
        `find "$TMPDIR" -maxdepth 1 \\( -name "*.xcdistributionlogs" -o -name "ResultBundle_*.xcresult" \\) -exec rm -rf {} + 2>/dev/null; ` +
        `echo done`;
      const sc = await exec(ssh, `bash -lc ${shq(sharedCleanup)}`, () => {});
      log(`[sweep] xcode shared-cache cleanup: exit ${sc.exitCode}`);
    });
  } catch (e) {
    log(`[sweep] failed: ${(e as Error).message}`);
  }
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
