import type { FastifyInstance } from "fastify";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { requireSuperadmin } from "../auth/middleware.js";
import { SESSION_COOKIE, getSession } from "../auth/session.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { env } from "../env.js";
import { writeAdminLog } from "../lib/adminLogs.js";

/**
 * Run this repo's deploy scripts from the locally-running API and stream their
 * output into the admin UI, so pushing tooling to a build host doesn't mean
 * dropping into a terminal and remembering flags.
 *
 * Three things keep an endpoint that spawns processes from being a liability:
 *
 *  1. **The command list is a constant.** Targets are declared below; a request
 *     picks one by id. No part of a request reaches an argv, so there is no
 *     command-injection surface (also why `spawn` is called without a shell).
 *  2. **Superadmin only**, via the same guard the rest of /admin uses. The
 *     WebSocket re-checks the session inline because @fastify/websocket bypasses
 *     route preHandlers.
 *  3. **Local development only** unless explicitly opted into. A production API
 *     has no business shelling out to deploy scripts, so the routes 403 there
 *     unless ADMIN_LOCAL_DEPLOY=true is set deliberately.
 *
 * Jobs live in memory: this is a dev-time console, the log matters while you're
 * watching it, and keeping it out of the database means no schema migration for
 * a feature that never runs in production.
 */

const MAX_LINES = 4000;
const MAX_JOBS = 25;
/** Grace period between SIGTERM and SIGKILL when cancelling. */
const KILL_AFTER_MS = 5_000;

const here = fileURLToPath(new URL(".", import.meta.url));
// routes/ → src/ → apps/api/ → apps/ → repo root
const repoRoot = resolvePath(here, "../../../..");

type JobState = "running" | "succeeded" | "failed" | "canceled";
type LineStream = "stdout" | "stderr" | "system";

interface DeployTarget {
  id: string;
  label: string;
  description: string;
  /** argv — never composed from request data. */
  command: string[];
  cwd: string;
}

const TARGETS: DeployTarget[] = [
  {
    id: "build-tools-ios",
    label: "iOS build tooling",
    description:
      "Pushes infra/tools/RaidX/Tools/ios to the Mac build host, then installs any missing build tooling (CocoaPods, xcbeautify) via Homebrew.",
    command: ["node", "infra/scripts/deploy-build-scripts.mjs", "--ios"],
    cwd: repoRoot,
  },
  {
    id: "build-tools-android",
    label: "Android build tooling",
    description:
      "Pushes infra/tools/RaidX/Tools/android to the Linux build host, and rebuilds the Docker builder image when its Dockerfile changed.",
    command: ["node", "infra/scripts/deploy-build-scripts.mjs", "--android"],
    cwd: repoRoot,
  },
  {
    id: "build-tools-all",
    label: "All build tooling",
    description: "Both platforms in one run: iOS to the Mac host, Android to the Linux host.",
    command: ["node", "infra/scripts/deploy-build-scripts.mjs"],
    cwd: repoRoot,
  },
];

interface LogLine {
  seq: number;
  ts: string;
  stream: LineStream;
  text: string;
}

interface Job {
  id: string;
  targetId: string;
  targetLabel: string;
  state: JobState;
  command: string[];
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  startedByUserId: string | null;
  lines: LogLine[];
  /** Set once MAX_LINES is hit, so the UI can say the log was clipped. */
  truncated: boolean;
  child: ChildProcessWithoutNullStreams | null;
  cancelRequested: boolean;
  killTimer: NodeJS.Timeout | null;
  listeners: Set<(event: StreamEvent) => void>;
  seq: number;
}

type StreamEvent =
  | { type: "line"; line: LogLine }
  | { type: "state"; state: JobState; exitCode: number | null; endedAt: string | null };

// Insertion-ordered, so trimming to MAX_JOBS drops the oldest.
const jobs = new Map<string, Job>();

function publicJob(job: Job, opts: { lines?: boolean; sinceSeq?: number } = {}) {
  return {
    id: job.id,
    targetId: job.targetId,
    targetLabel: job.targetLabel,
    state: job.state,
    command: job.command.join(" "),
    cwd: job.cwd,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    exitCode: job.exitCode,
    startedByUserId: job.startedByUserId,
    lineCount: job.lines.length,
    truncated: job.truncated,
    ...(opts.lines
      ? { lines: opts.sinceSeq ? job.lines.filter((l) => l.seq > opts.sinceSeq!) : job.lines }
      : {}),
  };
}

function push(job: Job, stream: LineStream, text: string) {
  const line: LogLine = { seq: ++job.seq, ts: new Date().toISOString(), stream, text };
  job.lines.push(line);
  if (job.lines.length > MAX_LINES) {
    job.lines.splice(0, job.lines.length - MAX_LINES);
    job.truncated = true;
  }
  for (const listen of job.listeners) listen({ type: "line", line });
}

function setState(job: Job, state: JobState, exitCode: number | null) {
  job.state = state;
  job.exitCode = exitCode;
  job.endedAt = new Date().toISOString();
  if (job.killTimer) {
    clearTimeout(job.killTimer);
    job.killTimer = null;
  }
  job.child = null;
  for (const listen of job.listeners) {
    listen({ type: "state", state, exitCode, endedAt: job.endedAt });
  }
}

/**
 * Splits a chunk into lines, carrying an unterminated tail until more arrives.
 * Without this, progress output that writes partial lines (scp, docker) shows
 * up as ragged fragments.
 */
function makeLineSplitter(onLine: (text: string) => void) {
  let buffer = "";
  return {
    write(chunk: string) {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        onLine(buffer.slice(0, idx).replace(/\r$/, ""));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
      }
      // Carriage-return progress bars never emit \n; flush on \r so they move.
      const cr = buffer.lastIndexOf("\r");
      if (cr !== -1) {
        onLine(buffer.slice(0, cr));
        buffer = buffer.slice(cr + 1);
      }
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

function runningJob(): Job | null {
  for (const job of jobs.values()) if (job.state === "running") return job;
  return null;
}

function start(target: DeployTarget, userId: string | null): Job {
  const job: Job = {
    id: randomUUID(),
    targetId: target.id,
    targetLabel: target.label,
    state: "running",
    command: target.command,
    cwd: target.cwd,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    startedByUserId: userId,
    lines: [],
    truncated: false,
    child: null,
    cancelRequested: false,
    killTimer: null,
    listeners: new Set(),
    seq: 0,
  };
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.entries()].find(([, j]) => j.state !== "running");
    if (!oldest) break;
    jobs.delete(oldest[0]);
  }

  push(job, "system", `$ ${target.command.join(" ")}`);
  push(job, "system", `cwd: ${target.cwd}`);

  const [cmd, ...args] = target.command;
  let child: ChildProcessWithoutNullStreams;
  try {
    // shell:false — argv is a constant, and no shell means no quoting hazard.
    child = spawn(cmd!, args, {
      cwd: target.cwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "1" },
    }) as ChildProcessWithoutNullStreams;
  } catch (err) {
    push(job, "stderr", err instanceof Error ? err.message : String(err));
    setState(job, "failed", null);
    return job;
  }
  job.child = child;

  const out = makeLineSplitter((text) => push(job, "stdout", text));
  const errStream = makeLineSplitter((text) => push(job, "stderr", text));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => out.write(c));
  child.stderr.on("data", (c: string) => errStream.write(c));

  child.on("error", (err) => {
    push(job, "stderr", err.message);
    if (job.state === "running") setState(job, "failed", null);
  });
  child.on("close", (code, signal) => {
    out.flush();
    errStream.flush();
    if (signal) push(job, "system", `process terminated by ${signal}`);
    push(job, "system", `exit code ${code ?? "null"}`);
    if (job.cancelRequested) setState(job, "canceled", code ?? null);
    else setState(job, code === 0 ? "succeeded" : "failed", code ?? null);
  });

  return job;
}

/** Local-deploy is a dev-time tool; refuse in production unless opted in. */
function deployEnabled(): boolean {
  return !env.isProd || env.ADMIN_LOCAL_DEPLOY;
}

export async function localDeployRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireSuperadmin);
  server.addHook("preHandler", async (req, reply) => {
    if (req.headers.upgrade?.toLowerCase() === "websocket") return;
    if (!deployEnabled()) {
      return reply.forbidden(
        "Local deploy is disabled on this API. It runs deploy scripts on the API host, so it's development-only unless ADMIN_LOCAL_DEPLOY=true.",
      );
    }
  });

  server.get("/admin/deploy/targets", async () => ({
    enabled: deployEnabled(),
    repoRoot,
    targets: TARGETS.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      command: t.command.join(" "),
      // A checkout that doesn't contain the script (a container image that
      // shipped only dist/, say) can't run it — say so before the click.
      available: existsSync(resolvePath(t.cwd, t.command[1] ?? "")),
    })),
  }));

  server.get("/admin/deploy/jobs", async () => ({
    jobs: [...jobs.values()].reverse().map((j) => publicJob(j)),
    runningId: runningJob()?.id ?? null,
  }));

  server.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/admin/deploy/jobs/:id",
    async (req, reply) => {
      const job = jobs.get(req.params.id);
      if (!job) return reply.notFound("Unknown deploy job");
      const since = Number(req.query.since ?? 0);
      return publicJob(job, { lines: true, sinceSeq: Number.isFinite(since) && since > 0 ? since : undefined });
    },
  );

  server.post<{ Params: { targetId: string } }>("/admin/deploy/targets/:targetId/run", async (req, reply) => {
    const target = TARGETS.find((t) => t.id === req.params.targetId);
    if (!target) return reply.notFound("Unknown deploy target");
    // One at a time: these mutate remote hosts, and two concurrent runs against
    // the same host would interleave scp writes and docker builds.
    const active = runningJob();
    if (active) {
      return reply.conflict(`A deploy is already running (${active.targetLabel}). Wait for it or cancel it first.`);
    }
    const scriptPath = resolvePath(target.cwd, target.command[1] ?? "");
    if (!existsSync(scriptPath)) return reply.failedDependency(`Deploy script not found at ${scriptPath}`);

    const job = start(target, req.auth?.userId ?? null);
    writeAdminLog(
      "admin_deploy.started",
      { target: target.id, job_id: job.id, command: target.command.join(" ") },
      req.auth?.userId,
    );
    return reply.code(202).send(publicJob(job, { lines: true }));
  });

  server.post<{ Params: { id: string } }>("/admin/deploy/jobs/:id/cancel", async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.notFound("Unknown deploy job");
    if (job.state !== "running" || !job.child) return reply.badRequest("Job is not running");
    job.cancelRequested = true;
    push(job, "system", "cancellation requested — sending SIGTERM");
    job.child.kill("SIGTERM");
    // ssh/scp ignore SIGTERM while mid-transfer often enough to matter.
    job.killTimer = setTimeout(() => {
      if (job.state === "running" && job.child) {
        push(job, "system", "still running — sending SIGKILL");
        job.child.kill("SIGKILL");
      }
    }, KILL_AFTER_MS);
    writeAdminLog("admin_deploy.canceled", { job_id: job.id, target: job.targetId }, req.auth?.userId);
    return publicJob(job);
  });

  // Live log stream. Sends a snapshot, then every subsequent line/state change.
  server.get<{ Params: { id: string } }>(
    "/admin/deploy/jobs/:id/stream",
    { websocket: true },
    async (socket, req) => {
      // @fastify/websocket skips route preHandlers, so both the auth check and
      // the dev-only gate are redone here.
      const sid = req.cookies[SESSION_COOKIE];
      const sess = sid ? await getSession(sid) : null;
      if (!sess) {
        socket.send(JSON.stringify({ type: "error", message: "unauthorized" }));
        socket.close(4401);
        return;
      }
      const [u] = await db
        .select({ isSuperadmin: users.isSuperadmin })
        .from(users)
        .where(eq(users.id, sess.userId))
        .limit(1);
      if (!u?.isSuperadmin) {
        socket.send(JSON.stringify({ type: "error", message: "forbidden" }));
        socket.close(4403);
        return;
      }
      if (!deployEnabled()) {
        socket.send(JSON.stringify({ type: "error", message: "local deploy disabled" }));
        socket.close(4403);
        return;
      }
      const job = jobs.get(req.params.id);
      if (!job) {
        socket.send(JSON.stringify({ type: "error", message: "not found" }));
        socket.close(4404);
        return;
      }

      const send = (event: StreamEvent) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      };
      socket.send(JSON.stringify({ type: "snapshot", job: publicJob(job, { lines: true }) }));
      if (job.state !== "running") {
        socket.close(1000);
        return;
      }
      job.listeners.add(send);
      socket.on("close", () => job.listeners.delete(send));
      socket.on("error", () => job.listeners.delete(send));
    },
  );
}
