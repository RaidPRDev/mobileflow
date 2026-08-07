import type { FastifyInstance } from "fastify";
import { count, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  apps,
  buildHosts,
  buildStacks,
  builds,
  companyInfo,
  oauthApps,
  orgMembers,
  organizations,
  paymentProcessors,
  payments,
  plans,
  sessions,
  subscriptions,
  users,
} from "../db/schema.js";
import { requireSuperadmin } from "../auth/middleware.js";
import { SESSION_COOKIE, getSession } from "../auth/session.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import {
  ALL_ADAPTERS,
  adapterDescriptor,
  clearActiveAdapterCache,
  sanitizeConfig,
  sanitizeCredentials,
  type ProviderId,
} from "../billing/adapters/registry.js";
import {
  PayPalAdapter,
  type PayPalConfigBlob,
  type PayPalCredentialsBlob,
} from "../billing/adapters/paypal.js";
import { Client as SshClient } from "ssh2";
import { exec, linuxSshTarget, macSshTarget, uploadBase64, withSsh, type SshTarget } from "../worker/ssh.js";
import { resolveLinuxHost } from "../worker/ssh.js";
import { env } from "../env.js";
import {
  deleteLogFile,
  listLogFiles,
  listLogMonths,
  listLogScopes,
  listLogYears,
  readLogFile,
} from "../lib/adminLogs.js";

// Synthesize read-only host entries from the `.env` file. The build runners
// fall back to these when no DB host matches a given kind, so admins should be
// able to see them in the UI even though they're not editable. The synthetic
// id encodes the kind so the client can detect env rows (id starts with "env:")
// and disable destructive actions.
function envHosts() {
  const out: Array<{
    id: string;
    name: string;
    kind: "linux_docker" | "mac";
    hostname: string;
    port: number;
    sshUser: string;
    remoteBase: string;
    downloadsBase: string;
    downloadsBaseUrl: string;
    toolsPath: string | null;
    capacity: number;
    online: boolean;
    createdAt: string;
    source: "env";
  }> = [];
  if (env.LINUX_BUILD_HOST) {
    out.push({
      id: "env:linux_docker",
      name: "Linux build host",
      kind: "linux_docker",
      hostname: env.LINUX_BUILD_HOST,
      port: env.LINUX_BUILD_PORT,
      sshUser: env.LINUX_BUILD_USER,
      remoteBase: env.LINUX_BUILD_REMOTE_BASE,
      downloadsBase: env.LINUX_BUILD_DOWNLOADS_BASE,
      downloadsBaseUrl: env.LINUX_BUILD_DOWNLOADS_BASE_URL,
      toolsPath: env.LINUX_BUILD_ANDROID_TOOLS,
      capacity: 1,
      online: true,
      createdAt: new Date(0).toISOString(),
      source: "env",
    });
  }
  if (env.MAC_BUILD_HOST && env.MAC_BUILD_USER) {
    out.push({
      id: "env:mac",
      name: "Mac build host",
      kind: "mac",
      hostname: env.MAC_BUILD_HOST,
      port: env.MAC_BUILD_PORT,
      sshUser: env.MAC_BUILD_USER,
      remoteBase: env.MAC_BUILD_REMOTE_BASE,
      downloadsBase: env.MAC_BUILD_DOWNLOADS_BASE,
      downloadsBaseUrl: env.MAC_BUILD_DOWNLOADS_BASE_URL,
      toolsPath: env.MAC_BUILD_TOOLS,
      capacity: 1,
      online: true,
      createdAt: new Date(0).toISOString(),
      source: "env",
    });
  }
  return out;
}

const PlanIdEnum = z.enum(["naboria", "bohio", "yucayeque", "cacique", "unlimited"]);

// Shell-quote for the Mac side. Matches the pattern used in the runners.
function shqMac(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export async function adminRoutes(server: FastifyInstance) {
  // Skip the http preHandler on WS upgrade requests — @fastify/websocket
  // bypasses route preHandlers and `requireSuperadmin` would short-circuit
  // the handshake. The terminal WS route re-does the superadmin check
  // inline before opening the SSH shell.
  server.addHook("preHandler", async (req, reply) => {
    if (req.headers.upgrade?.toLowerCase() === "websocket") return;
    return requireSuperadmin(req, reply);
  });

  // ---------- Orgs ----------

  server.get("/admin/orgs", async () => {
    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        ownerUserId: organizations.ownerUserId,
        createdAt: organizations.createdAt,
        planId: subscriptions.planId,
        planStatus: subscriptions.status,
      })
      .from(organizations)
      .leftJoin(subscriptions, eq(subscriptions.orgId, organizations.id))
      .orderBy(desc(organizations.createdAt));
    return rows;
  });

  server.get<{ Params: { orgId: string } }>("/admin/orgs/:orgId", async (req, reply) => {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, req.params.orgId)).limit(1);
    if (!org) return reply.notFound();
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, org.id)).limit(1);
    const members = await db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: orgMembers.role,
        isSuperadmin: users.isSuperadmin,
      })
      .from(orgMembers)
      .innerJoin(users, eq(users.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, org.id));
    const orgApps = await db
      .select({ id: apps.id, name: apps.name, runtime: apps.runtime, gitRepoFullName: apps.gitRepoFullName, createdAt: apps.createdAt })
      .from(apps)
      .where(eq(apps.orgId, org.id));
    const recentBuilds = await db
      .select({
        id: builds.id,
        appId: builds.appId,
        status: builds.status,
        target: builds.target,
        createdAt: builds.createdAt,
        commitSha: builds.commitSha,
      })
      .from(builds)
      .innerJoin(apps, eq(apps.id, builds.appId))
      .where(eq(apps.orgId, org.id))
      .orderBy(desc(builds.createdAt))
      .limit(20);
    return { org, subscription: sub ?? null, members, apps: orgApps, recentBuilds };
  });

  server.patch<{ Params: { orgId: string } }>("/admin/orgs/:orgId/plan", async (req, reply) => {
    const body = z.object({ planId: PlanIdEnum }).parse(req.body);
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, req.params.orgId)).limit(1);
    if (!org) return reply.notFound();
    await db
      .insert(subscriptions)
      .values({ orgId: org.id, planId: body.planId, status: "active" })
      .onConflictDoUpdate({
        target: subscriptions.orgId,
        set: { planId: body.planId, status: "active" },
      });
    return { ok: true };
  });

  server.delete<{ Params: { orgId: string } }>("/admin/orgs/:orgId", async (req, reply) => {
    const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, req.params.orgId)).limit(1);
    if (!org) return reply.notFound();
    await db.delete(organizations).where(eq(organizations.id, org.id));
    return reply.code(204).send();
  });

  // ---------- Users ----------

  server.get("/admin/users", async () => {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        avatarUrl: users.avatarUrl,
        isSuperadmin: users.isSuperadmin,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt));
    const memberships = await db
      .select({
        userId: orgMembers.userId,
        orgId: orgMembers.orgId,
        orgName: organizations.name,
        role: orgMembers.role,
      })
      .from(orgMembers)
      .innerJoin(organizations, eq(organizations.id, orgMembers.orgId));
    return rows.map((u) => ({
      ...u,
      memberships: memberships.filter((m) => m.userId === u.id).map(({ userId: _u, ...rest }) => rest),
    }));
  });

  server.patch<{ Params: { userId: string } }>("/admin/users/:userId", async (req, reply) => {
    const body = z.object({ isSuperadmin: z.boolean().optional(), name: z.string().min(1).max(120).optional() }).strict().parse(req.body);
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, req.params.userId)).limit(1);
    if (!u) return reply.notFound();
    await db.update(users).set(body).where(eq(users.id, u.id));
    return { ok: true };
  });

  server.post<{ Params: { userId: string } }>("/admin/users/:userId/force-logout", async (req, reply) => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, req.params.userId)).limit(1);
    if (!u) return reply.notFound();
    await db.delete(sessions).where(eq(sessions.userId, u.id));
    return { ok: true };
  });

  server.delete<{ Params: { userId: string } }>("/admin/users/:userId", async (req, reply) => {
    if (req.params.userId === req.auth!.userId) return reply.badRequest("Cannot delete yourself");
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, req.params.userId)).limit(1);
    if (!u) return reply.notFound();
    // organizations.ownerUserId is ON DELETE RESTRICT, so deleting the user
    // directly fails for anyone who owns an org. Drop the owned orgs first;
    // cascades wipe apps/builds/subs/etc. then we can safely delete the user.
    const owned = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.ownerUserId, u.id));
    for (const o of owned) {
      await db.delete(organizations).where(eq(organizations.id, o.id));
    }
    await db.delete(users).where(eq(users.id, u.id));
    return reply.code(204).send();
  });

  // ---------- Builds (cross-org) ----------

  server.get("/admin/builds", async () => {
    const rows = await db
      .select({
        id: builds.id,
        status: builds.status,
        target: builds.target,
        stackId: builds.stackId,
        commitSha: builds.commitSha,
        createdAt: builds.createdAt,
        startedAt: builds.startedAt,
        finishedAt: builds.finishedAt,
        appId: builds.appId,
        appName: apps.name,
        orgId: apps.orgId,
        orgName: organizations.name,
      })
      .from(builds)
      .innerJoin(apps, eq(apps.id, builds.appId))
      .innerJoin(organizations, eq(organizations.id, apps.orgId))
      .orderBy(desc(builds.createdAt))
      .limit(100);
    return rows;
  });

  // ---------- Plans ----------

  server.get("/admin/plans", async () => db.select().from(plans).orderBy(plans.sortOrder));

  server.patch<{ Params: { planId: string } }>("/admin/plans/:planId", async (req, reply) => {
    const PatchPlan = z
      .object({
        name: z.string().min(1).max(80),
        priceCents: z.number().int().nonnegative(),
        maxApps: z.number().int().nonnegative().nullable(),
        maxSeats: z.number().int().nonnegative().nullable(),
        maxConcurrentBuilds: z.number().int().nonnegative().nullable(),
        canBuild: z.boolean(),
        stripePriceId: z.string().nullable(),
      })
      .partial();
    const body = PatchPlan.parse(req.body);
    const planIdParsed = PlanIdEnum.safeParse(req.params.planId);
    if (!planIdParsed.success) return reply.badRequest("Unknown plan");
    if (planIdParsed.data === "unlimited") return reply.badRequest("Unlimited plan is read-only");
    const [updated] = await db
      .update(plans)
      .set(body)
      .where(eq(plans.id, planIdParsed.data))
      .returning();
    return updated ?? reply.notFound();
  });

  // ---------- Build hosts ----------

  const HostBody = z.object({
    name: z.string().min(1).max(80),
    kind: z.enum(["linux_docker", "mac"]),
    hostname: z.string().min(1).max(255),
    port: z.number().int().positive().default(22),
    sshUser: z.string().min(1).max(80),
    sshKey: z.string().min(50), // PEM body
    // Mac→Linux key. Only meaningful on `kind = mac`. Pushed to the Mac on
    // demand via /admin/hosts/:id/push-artifact-key; stored encrypted so we
    // can re-push without re-prompting (rotation, re-onboarding a Mac).
    artifactKey: z.string().min(50).nullable().optional(),
    remoteBase: z.string().min(1),
    downloadsBase: z.string().min(1),
    downloadsBaseUrl: z.string().url(),
    toolsPath: z.string().nullable().optional(),
    capacity: z.number().int().positive().default(2),
    online: z.boolean().default(true),
  });

  server.get("/admin/hosts", async () => {
    const rows = await db.select().from(buildHosts).orderBy(buildHosts.name);
    // Strip raw key material but expose a boolean so the UI can show whether
    // a Mac already has a stored artifact-server key.
    const dbHosts = rows.map(({ sshKeyEnc: _k, artifactKeyEnc, ...rest }) => ({
      ...rest,
      hasArtifactKey: !!artifactKeyEnc,
      source: "db" as const,
    }));
    return [
      ...dbHosts,
      ...envHosts().map((h) => ({ ...h, hasArtifactKey: false })),
    ];
  });

  server.post("/admin/hosts", async (req, reply) => {
    const body = HostBody.parse(req.body);
    // Mac hosts must carry an artifact-server key — without it, iOS builds
    // succeed locally but can't push to the Linux downloads host. We enforce
    // here too (not just in the UI) since the API is the contract.
    if (body.kind === "mac" && !body.artifactKey) {
      return reply.code(400).send({
        error: "Mac hosts require an artifact-server SSH key (Mac → Linux) so build artifacts can be uploaded to the downloads host.",
      });
    }
    const [created] = await db
      .insert(buildHosts)
      .values({
        name: body.name,
        kind: body.kind,
        hostname: body.hostname,
        port: body.port,
        sshUser: body.sshUser,
        sshKeyEnc: encryptString(body.sshKey.replace(/\\n/g, "\n")),
        artifactKeyEnc:
          body.kind === "mac" && body.artifactKey
            ? encryptString(body.artifactKey.replace(/\\n/g, "\n"))
            : null,
        remoteBase: body.remoteBase,
        downloadsBase: body.downloadsBase,
        downloadsBaseUrl: body.downloadsBaseUrl,
        toolsPath: body.toolsPath ?? null,
        capacity: body.capacity,
        online: body.online,
      })
      .returning();
    if (!created) return reply.internalServerError();
    const { sshKeyEnc: _k, artifactKeyEnc, ...safe } = created;
    return reply.code(201).send({ ...safe, hasArtifactKey: !!artifactKeyEnc });
  });

  server.patch<{ Params: { id: string } }>("/admin/hosts/:id", async (req, reply) => {
    const PatchHost = HostBody.partial();
    const body = PatchHost.parse(req.body);
    const patch: Record<string, unknown> = { ...body };
    if (typeof body.sshKey === "string") {
      patch.sshKeyEnc = encryptString(body.sshKey.replace(/\\n/g, "\n"));
      delete patch.sshKey;
    }
    if (body.artifactKey === null) {
      patch.artifactKeyEnc = null;
      delete patch.artifactKey;
    } else if (typeof body.artifactKey === "string") {
      patch.artifactKeyEnc = encryptString(body.artifactKey.replace(/\\n/g, "\n"));
      delete patch.artifactKey;
    }
    const [updated] = await db.update(buildHosts).set(patch).where(eq(buildHosts.id, req.params.id)).returning();
    if (!updated) return reply.notFound();
    const { sshKeyEnc: _k, artifactKeyEnc, ...safe } = updated;
    return { ...safe, hasArtifactKey: !!artifactKeyEnc };
  });

  server.delete<{ Params: { id: string } }>("/admin/hosts/:id", async (req, reply) => {
    const [row] = await db.select({ id: buildHosts.id }).from(buildHosts).where(eq(buildHosts.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    await db.delete(buildHosts).where(eq(buildHosts.id, row.id));
    return reply.code(204).send();
  });

  server.post<{ Params: { id: string } }>("/admin/hosts/:id/test", async (req, reply) => {
    let target: SshTarget | null = null;
    if (req.params.id === "env:linux_docker") {
      target = linuxSshTarget();
    } else if (req.params.id === "env:mac") {
      target = macSshTarget();
    } else {
      const [row] = await db.select().from(buildHosts).where(eq(buildHosts.id, req.params.id)).limit(1);
      if (!row) return reply.notFound();
      target = {
        host: row.hostname,
        port: row.port,
        username: row.sshUser,
        privateKey: Buffer.from(decryptString(row.sshKeyEnc), "utf8"),
      };
    }
    if (!target) return reply.code(400).send({ error: "Host not configured" });
    try {
      const out: string[] = [];
      const result = await withSsh(target, (ssh) =>
        exec(ssh, "uname -a && echo ok", (line) => {
          out.push(line);
        }),
      );
      return { ok: result.exitCode === 0, exitCode: result.exitCode, output: out.join("\n") };
    } catch (err) {
      return reply.code(200).send({ ok: false, error: (err as Error).message });
    }
  });

  // Interactive SSH terminal over WebSocket. Opens a PTY-backed shell on the
  // build host and pipes bytes in both directions. Closing the socket ends the
  // ssh2 channel, which SIGHUPs the remote shell and kills any foreground
  // process group attached to it. Wire protocol (JSON text frames):
  //   client → server: { type: "input",  data: string }
  //                    { type: "resize", cols: number, rows: number }
  //   server → client: { type: "data",   data: string }
  //                    { type: "ready" }
  //                    { type: "exit",   code?: number, signal?: string }
  //                    { type: "error",  message: string }
  server.get<{ Params: { id: string } }>(
    "/admin/hosts/:id/terminal",
    { websocket: true },
    async (socket, req) => {
      const closeWith = (code: number, msg?: string) => {
        try {
          if (msg) socket.send(JSON.stringify({ type: "error", message: msg }));
        } catch { /* ignore */ }
        try { socket.close(code); } catch { /* ignore */ }
      };

      // WS bypasses the route preHandler, so we re-check superadmin inline.
      const sid = req.cookies[SESSION_COOKIE];
      const sess = sid ? await getSession(sid) : null;
      if (!sess) return closeWith(4401, "unauthorized");
      const [u] = await db
        .select({ id: users.id, isSuperadmin: users.isSuperadmin })
        .from(users)
        .where(eq(users.id, sess.userId))
        .limit(1);
      if (!u || !u.isSuperadmin) return closeWith(4403, "forbidden");

      // Resolve target the same way testHost does.
      let target: SshTarget | null = null;
      if (req.params.id === "env:linux_docker") {
        target = linuxSshTarget();
      } else if (req.params.id === "env:mac") {
        target = macSshTarget();
      } else {
        const [row] = await db.select().from(buildHosts).where(eq(buildHosts.id, req.params.id)).limit(1);
        if (!row) return closeWith(4404, "host not found");
        target = {
          host: row.hostname,
          port: row.port,
          username: row.sshUser,
          privateKey: Buffer.from(decryptString(row.sshKeyEnc), "utf8"),
        };
      }
      if (!target) return closeWith(4400, "host not configured");

      const client = new SshClient();
      let stream: import("ssh2").ClientChannel | null = null;
      let closed = false;

      const tearDown = () => {
        if (closed) return;
        closed = true;
        try { stream?.close(); } catch { /* ignore */ }
        try { client.end(); } catch { /* ignore */ }
      };

      socket.on("close", tearDown);
      socket.on("error", tearDown);

      client.once("error", (err) => {
        closeWith(1011, `ssh: ${err.message}`);
        tearDown();
      });

      client.once("ready", () => {
        client.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (err, sh) => {
          if (err) {
            closeWith(1011, `shell: ${err.message}`);
            tearDown();
            return;
          }
          stream = sh;
          try { socket.send(JSON.stringify({ type: "ready" })); } catch { /* ignore */ }

          sh.on("data", (chunk: Buffer) => {
            if (closed) return;
            try {
              socket.send(JSON.stringify({ type: "data", data: chunk.toString("utf8") }));
            } catch { /* ignore */ }
          });
          sh.stderr.on("data", (chunk: Buffer) => {
            if (closed) return;
            try {
              socket.send(JSON.stringify({ type: "data", data: chunk.toString("utf8") }));
            } catch { /* ignore */ }
          });
          sh.on("close", (code: number | null, signal: string | null) => {
            try {
              socket.send(JSON.stringify({ type: "exit", code: code ?? undefined, signal: signal ?? undefined }));
            } catch { /* ignore */ }
            tearDown();
            try { socket.close(1000); } catch { /* ignore */ }
          });

          socket.on("message", (raw: Buffer) => {
            if (!stream || closed) return;
            let msg: { type?: string; data?: string; cols?: number; rows?: number };
            try {
              msg = JSON.parse(raw.toString("utf8"));
            } catch {
              return;
            }
            if (msg.type === "input" && typeof msg.data === "string") {
              try { stream.write(msg.data); } catch { /* ignore */ }
            } else if (msg.type === "resize" && msg.cols && msg.rows) {
              try { stream.setWindow(msg.rows, msg.cols, 0, 0); } catch { /* ignore */ }
            }
          });
        });
      });

      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        privateKey: target.privateKey,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
      });
    },
  );

  // Scan + optionally delete orphaned build directories on a host. A build dir
  // is orphaned when its name (the leaf segment after `<base>/<orgId>/`) is
  // not in the current `builds.id` set — typically because the DB was reset,
  // or a build was hard-deleted while artifacts remained.
  //
  // Layout is `<base>/<orgId>/<buildId>/` for both `remoteBase` (build
  // sandboxes) and `downloadsBase` (artifacts on Linux). Two-phase API: a
  // `dryRun: true` request returns the list of orphans; without dryRun the
  // listed dirs are removed in-place.
  server.post<{
    Params: { id: string };
    Body: { dryRun?: boolean };
  }>("/admin/hosts/:id/cleanup-orphans", async (req, reply) => {
    const body = z.object({ dryRun: z.boolean().optional() }).parse(req.body ?? {});

    // Resolve target + paths from either a DB host or an env entry. We need
    // remoteBase/downloadsBase paths to scan, so env hosts go through the
    // resolver helpers rather than the raw SshTarget shape.
    let target: SshTarget | null = null;
    let remoteBase: string | null = null;
    let downloadsBase: string | null = null;
    let kind: "linux_docker" | "mac" | null = null;
    if (req.params.id === "env:linux_docker") {
      const t = linuxSshTarget();
      if (!t) return reply.code(400).send({ error: "Linux env host not configured" });
      target = t;
      remoteBase = env.LINUX_BUILD_REMOTE_BASE;
      downloadsBase = env.LINUX_BUILD_DOWNLOADS_BASE;
      kind = "linux_docker";
    } else if (req.params.id === "env:mac") {
      const t = macSshTarget();
      if (!t) return reply.code(400).send({ error: "Mac env host not configured" });
      target = t;
      remoteBase = env.MAC_BUILD_REMOTE_BASE;
      // Macs don't host artifacts long-term — those scp out to Linux. Skip.
      downloadsBase = null;
      kind = "mac";
    } else {
      const [row] = await db.select().from(buildHosts).where(eq(buildHosts.id, req.params.id)).limit(1);
      if (!row) return reply.notFound();
      target = {
        host: row.hostname,
        port: row.port,
        username: row.sshUser,
        privateKey: Buffer.from(decryptString(row.sshKeyEnc), "utf8"),
      };
      remoteBase = row.remoteBase;
      downloadsBase = row.kind === "linux_docker" ? row.downloadsBase : null;
      kind = row.kind;
    }

    // Pull the current build-id set once; we'll compare each leaf dir against
    // it. For a freshly nuked DB this is empty, so every dir is orphaned.
    const knownBuilds = await db.select({ id: builds.id }).from(builds);
    const knownSet = new Set(knownBuilds.map((b) => b.id));

    // Find dirs at depth 2 (orgId/buildId). Quote the base path; if `find`
    // can't read it (path doesn't exist on fresh hosts), treat as empty.
    const listDirs = async (ssh: import("ssh2").Client, base: string): Promise<string[]> => {
      const cmd = `find ${shqMac(base)} -mindepth 2 -maxdepth 2 -type d 2>/dev/null || true`;
      const out: string[] = [];
      const sink = (line: string): void => {
        out.push(line);
      };
      const r = await exec(ssh, cmd, sink);
      if (r.exitCode !== 0) return [];
      return out.map((l) => l.trim()).filter(Boolean);
    };

    try {
      const result = await withSsh(target, async (ssh) => {
        const remoteDirs = remoteBase ? await listDirs(ssh, remoteBase) : [];
        const downloadDirs = downloadsBase ? await listDirs(ssh, downloadsBase) : [];

        const isOrphan = (path: string) => {
          const buildId = path.split("/").filter(Boolean).pop() ?? "";
          return buildId && !knownSet.has(buildId);
        };
        const remoteOrphans = remoteDirs.filter(isOrphan);
        const downloadOrphans = downloadDirs.filter(isOrphan);

        // Without dryRun, delete each orphan. Using a single shell invocation
        // per path so a bad path can't take down the whole sweep.
        let deleted = 0;
        const deleteLog: string[] = [];
        if (body.dryRun !== true) {
          for (const p of [...remoteOrphans, ...downloadOrphans]) {
            const r = await exec(
              ssh,
              `rm -rf ${shqMac(p)} && echo "deleted ${p}"`,
              (line: string): void => {
                deleteLog.push(line);
              },
            );
            if (r.exitCode === 0) deleted++;
          }
        }

        return {
          kind,
          remoteBase,
          downloadsBase,
          remoteOrphans,
          downloadOrphans,
          totalOrphans: remoteOrphans.length + downloadOrphans.length,
          dryRun: body.dryRun === true,
          deleted,
          deleteLog: deleteLog.join("\n"),
        };
      });
      return { ok: true, ...result };
    } catch (err) {
      return reply.code(200).send({ ok: false, error: (err as Error).message });
    }
  });

  // Push the stored Mac→Linux SSH key onto the Mac at ~/.ssh/raidx_linux_key,
  // ssh-keyscan the Linux box into known_hosts, and verify by running `echo ok`
  // over the new key. Optionally accepts a fresh `artifactKey` body which
  // overwrites the stored one before the push (used for rotation / first-time
  // setup when the key wasn't supplied at create time).
  server.post<{
    Params: { id: string };
    Body: { artifactKey?: string };
  }>("/admin/hosts/:id/push-artifact-key", async (req, reply) => {
    const body = z
      .object({ artifactKey: z.string().min(50).optional() })
      .parse(req.body ?? {});

    const [row] = await db.select().from(buildHosts).where(eq(buildHosts.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    if (row.kind !== "mac") return reply.badRequest("Artifact-key push is only valid for Mac hosts");

    // Update stored key first if a new one was supplied. We do this before
    // attempting the push so a rotation persists even if the push then fails.
    let artifactKeyPem: string | null = null;
    if (body.artifactKey) {
      artifactKeyPem = body.artifactKey.replace(/\\n/g, "\n");
      await db
        .update(buildHosts)
        .set({ artifactKeyEnc: encryptString(artifactKeyPem) })
        .where(eq(buildHosts.id, row.id));
    } else if (row.artifactKeyEnc) {
      artifactKeyPem = decryptString(row.artifactKeyEnc);
    } else {
      return reply.badRequest("No artifact key stored for this host and none supplied");
    }

    const linuxHost = await resolveLinuxHost();
    if (!linuxHost) {
      return reply.badRequest("Linux build host is not configured — add one before pushing the artifact key");
    }

    const macTarget: SshTarget = {
      host: row.hostname,
      port: row.port,
      username: row.sshUser,
      privateKey: Buffer.from(decryptString(row.sshKeyEnc), "utf8"),
    };

    try {
      const out: string[] = [];
      const sink = (line: string) => { out.push(line); };
      await withSsh(macTarget, async (ssh) => {
        // 1. ~/.ssh exists with the right permissions.
        const r1 = await exec(
          ssh,
          `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo ok`,
          sink,
        );
        if (r1.exitCode !== 0) throw new Error(`mkdir ~/.ssh failed (exit ${r1.exitCode})`);

        // 2. Write the key. uploadBase64 pipes via `base64 -D` (mac).
        await uploadBase64(ssh, {
          base64: Buffer.from(artifactKeyPem!, "utf8").toString("base64"),
          remotePath: "~/.ssh/raidx_linux_key",
          label: "artifact key",
          decoder: "mac",
        });
        const r2 = await exec(ssh, `chmod 600 ~/.ssh/raidx_linux_key && echo ok`, sink);
        if (r2.exitCode !== 0) throw new Error(`chmod key failed (exit ${r2.exitCode})`);

        // 3. ssh-keyscan the Linux host into known_hosts (idempotent — dedupe
        //    by piping through sort -u so reruns don't append duplicates).
        const scanCmd =
          `touch ~/.ssh/known_hosts && ` +
          `(ssh-keyscan -p ${linuxHost.port} -H ${shqMac(linuxHost.host)} 2>/dev/null; cat ~/.ssh/known_hosts) ` +
          `| sort -u > ~/.ssh/known_hosts.tmp && ` +
          `mv ~/.ssh/known_hosts.tmp ~/.ssh/known_hosts && chmod 644 ~/.ssh/known_hosts && echo ok`;
        const r3 = await exec(ssh, scanCmd, sink);
        if (r3.exitCode !== 0) throw new Error(`ssh-keyscan failed (exit ${r3.exitCode})`);

        // 4. Verify by running a noop command on the Linux host *from* the Mac
        //    using the freshly written key. Confirms the whole chain end-to-end.
        const verifyCmd =
          `ssh -i ~/.ssh/raidx_linux_key -p ${linuxHost.port} -o StrictHostKeyChecking=yes ` +
          `${shqMac(`${linuxHost.username}@${linuxHost.host}`)} ${shqMac("echo ok")}`;
        const r4 = await exec(ssh, verifyCmd, sink);
        if (r4.exitCode !== 0) {
          throw new Error(`Verify failed (exit ${r4.exitCode}). Output:\n${out.slice(-20).join("\n")}`);
        }
      });
      return { ok: true, output: out.join("\n") };
    } catch (err) {
      return reply.code(200).send({ ok: false, error: (err as Error).message, output: undefined });
    }
  });

  // ---------- Build stacks ----------

  // Build stacks are the tooling identifier on each build (e.g. `ios-25.6`,
  // `android-default`). Read-only public listing lives on /stacks; admin
  // write endpoints live here. Delete is FK-restricted by `builds.stackId`
  // so historical builds keep resolving — Postgres surfaces a 23503 violation
  // that we translate into a 409.
  const StackBody = z.object({
    id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i, "lowercase id with dots/dashes/underscores"),
    platform: z.enum(["ios", "android", "web"]),
    label: z.string().min(1).max(120),
    image: z.string().min(1).max(200).nullable().optional(),
    isDefault: z.boolean().default(false),
    sortOrder: z.number().int().default(0),
    // Pin builds on this stack to one host: build_hosts.id or "env:mac" /
    // "env:linux_docker". Null/absent = automatic (first online of the kind).
    buildHostId: z.string().min(1).max(80).nullable().optional(),
  });

  // A pinned host must exist and match the stack's platform (ios → mac,
  // android/web → linux_docker) — catching that at save time beats a build
  // failing at run time.
  async function validateStackHostPin(
    platform: "ios" | "android" | "web",
    buildHostId: string | null | undefined,
  ): Promise<string | null> {
    if (!buildHostId) return null;
    const expectedKind = platform === "ios" ? "mac" : "linux_docker";
    if (buildHostId === "env:mac" || buildHostId === "env:linux_docker") {
      const kind = buildHostId === "env:mac" ? "mac" : "linux_docker";
      return kind === expectedKind ? null : `An ${platform} stack needs a ${expectedKind} host, not ${buildHostId}`;
    }
    const [row] = await db.select().from(buildHosts).where(eq(buildHosts.id, buildHostId)).limit(1);
    if (!row) return "Unknown build host";
    if (row.kind !== expectedKind) return `"${row.name}" is a ${row.kind} host, but an ${platform} stack needs ${expectedKind}`;
    return null;
  }

  server.post("/admin/stacks", async (req, reply) => {
    const body = StackBody.parse(req.body);
    const pinError = await validateStackHostPin(body.platform, body.buildHostId);
    if (pinError) return reply.badRequest(pinError);
    const [created] = await db
      .insert(buildStacks)
      .values({
        id: body.id,
        platform: body.platform,
        label: body.label,
        image: body.image ?? null,
        isDefault: body.isDefault,
        sortOrder: body.sortOrder,
        buildHostId: body.buildHostId ?? null,
      })
      .returning();
    if (!created) return reply.internalServerError();
    return reply.code(201).send(created);
  });

  server.patch<{ Params: { id: string } }>("/admin/stacks/:id", async (req, reply) => {
    const PatchStack = StackBody.partial().omit({ id: true });
    const body = PatchStack.parse(req.body);
    if (body.buildHostId !== undefined) {
      const [existing] = await db.select().from(buildStacks).where(eq(buildStacks.id, req.params.id)).limit(1);
      if (!existing) return reply.notFound();
      const pinError = await validateStackHostPin(body.platform ?? existing.platform, body.buildHostId);
      if (pinError) return reply.badRequest(pinError);
    }
    const [updated] = await db
      .update(buildStacks)
      .set(body)
      .where(eq(buildStacks.id, req.params.id))
      .returning();
    if (!updated) return reply.notFound();
    return updated;
  });

  server.delete<{ Params: { id: string } }>("/admin/stacks/:id", async (req, reply) => {
    try {
      const result = await db.delete(buildStacks).where(eq(buildStacks.id, req.params.id)).returning();
      if (result.length === 0) return reply.notFound();
      return reply.code(204).send();
    } catch (err) {
      // 23503 = foreign_key_violation. The error.code field is on the postgres
      // driver's error; cast loosely to avoid pulling the type in here.
      if ((err as { code?: string }).code === "23503") {
        return reply.code(409).send({
          error:
            "Stack is referenced by one or more builds and can't be deleted. Reassign or delete those builds first.",
        });
      }
      throw err;
    }
  });

  // ---------- OAuth apps ----------

  const OAuthAppBody = z.object({
    provider: z.enum(["google", "github", "gitlab", "bitbucket"]),
    kind: z.enum(["signin", "git"]),
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(500),
    scopes: z.string().max(500).nullable().optional(),
    enabled: z.boolean().optional(),
  });

  server.get("/admin/oauth-apps", async () => {
    const rows = await db.select().from(oauthApps).orderBy(oauthApps.provider);
    return rows.map(({ clientSecretEnc: _s, ...rest }) => rest);
  });

  server.post("/admin/oauth-apps", async (req, reply) => {
    const body = OAuthAppBody.parse(req.body);
    const [created] = await db
      .insert(oauthApps)
      .values({
        provider: body.provider,
        kind: body.kind,
        clientId: body.clientId,
        clientSecretEnc: encryptString(body.clientSecret),
        scopes: body.scopes ?? null,
        enabled: body.enabled ?? true,
      })
      .onConflictDoUpdate({
        target: [oauthApps.provider, oauthApps.kind],
        set: {
          clientId: body.clientId,
          clientSecretEnc: encryptString(body.clientSecret),
          scopes: body.scopes ?? null,
          enabled: body.enabled ?? true,
        },
      })
      .returning();
    if (!created) return reply.internalServerError();
    const { clientSecretEnc: _s, ...safe } = created;
    return reply.code(201).send(safe);
  });

  server.delete<{ Params: { id: string } }>("/admin/oauth-apps/:id", async (req, reply) => {
    const [row] = await db.select({ id: oauthApps.id }).from(oauthApps).where(eq(oauthApps.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    await db.delete(oauthApps).where(eq(oauthApps.id, row.id));
    return reply.code(204).send();
  });

  // ---------- Payment processors ----------
  //
  // One row per supported processor; at most one has `enabled = true`. The
  // page is driven by adapter metadata (credentialsSchema / configSchema)
  // so adding a processor doesn't require admin-UI changes.

  const PaymentProviderEnum = z.enum(["stripe", "paypal", "connectpay"] as const);
  const PaymentModeEnum = z.enum(["sandbox", "production"] as const);

  // Body shape: arbitrary nested JSON inside `credentials` / `config`. Each
  // adapter validates its own shape on construction; we only enforce JSON
  // here. Secrets are only persisted when the caller sends a non-empty
  // string; missing keys leave the stored value untouched (so the admin can
  // edit non-secret fields without re-pasting secrets every time).
  const PaymentProcessorBody = z
    .object({
      enabled: z.boolean().optional(),
      mode: PaymentModeEnum.optional(),
      credentials: z.record(z.unknown()).optional(),
      config: z.record(z.unknown()).optional(),
    })
    .strict();

  server.get("/admin/payment-processors", async () => {
    const rows = await db.select().from(paymentProcessors);
    const processors = ALL_ADAPTERS.map((descriptor) => {
      const row = rows.find((r) => r.provider === descriptor.id);
      const creds = row?.credentialsEnc
        ? (JSON.parse(decryptString(row.credentialsEnc)) as Record<string, unknown>)
        : {};
      const config = row?.configEnc
        ? (JSON.parse(decryptString(row.configEnc)) as Record<string, unknown>)
        : {};
      return {
        provider: descriptor.id,
        displayName: descriptor.displayName,
        credentialsSchema: descriptor.credentialsSchema,
        configSchema: descriptor.configSchema,
        enabled: row?.enabled ?? false,
        mode: row?.mode ?? "sandbox",
        credentials: sanitizeCredentials(descriptor.credentialsSchema, creds),
        config: sanitizeConfig(descriptor.configSchema, config),
        updatedAt: row?.updatedAt ?? null,
      };
    });
    // Surface API_BASE_URL so the admin UI can render webhook endpoints that
    // match what processors actually need to POST to (ngrok / prod), rather
    // than guessing from the browser's window.location.origin.
    return { apiBaseUrl: env.API_BASE_URL, processors };
  });

  server.patch<{ Params: { provider: string } }>(
    "/admin/payment-processors/:provider",
    async (req, reply) => {
      const providerParse = PaymentProviderEnum.safeParse(req.params.provider);
      if (!providerParse.success) return reply.badRequest("Unknown processor");
      const provider = providerParse.data as ProviderId;
      if (!adapterDescriptor(provider)) return reply.notFound();
      const body = PaymentProcessorBody.parse(req.body);

      // Load existing blob (if any) so we can merge — secrets the admin
      // didn't re-paste must persist.
      const [existing] = await db
        .select()
        .from(paymentProcessors)
        .where(eq(paymentProcessors.provider, provider))
        .limit(1);
      const existingCreds = existing?.credentialsEnc
        ? (JSON.parse(decryptString(existing.credentialsEnc)) as Record<string, unknown>)
        : {};
      const existingConfig = existing?.configEnc
        ? (JSON.parse(decryptString(existing.configEnc)) as Record<string, unknown>)
        : {};
      const mergedCreds = body.credentials
        ? deepMerge(existingCreds, body.credentials, { dropEmpty: true })
        : existingCreds;
      const mergedConfig = body.config
        ? deepMerge(existingConfig, body.config, { dropEmpty: false })
        : existingConfig;

      // Activating this row toggles every other row off — enforces the
      // "exactly one active processor" rule at the SQL layer rather than
      // depending on a partial unique index.
      if (body.enabled === true) {
        await db.update(paymentProcessors).set({ enabled: false });
      }

      const credentialsEnc = encryptString(JSON.stringify(mergedCreds));
      const configEnc = encryptString(JSON.stringify(mergedConfig));
      const mode = body.mode ?? existing?.mode ?? "sandbox";
      const enabled = body.enabled ?? existing?.enabled ?? false;

      const [row] = await db
        .insert(paymentProcessors)
        .values({
          provider,
          enabled,
          mode,
          credentialsEnc,
          configEnc,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: paymentProcessors.provider,
          set: { enabled, mode, credentialsEnc, configEnc, updatedAt: new Date() },
        })
        .returning();
      clearActiveAdapterCache();
      if (!row) return reply.internalServerError();
      return { ok: true };
    },
  );

  // Provision a Product + Plan in PayPal's catalog using the saved sandbox
  // or production credentials. PayPal removed the manual plan-creation UI
  // from sandbox.paypal.com a while back, so without this endpoint admins
  // would have to run curl against /v1/catalogs/products and /v1/billing/plans
  // by hand for every tier. The response returns the new plan id; the admin
  // UI inserts it into the form's Plan ID field but does not auto-save —
  // the admin clicks Save as usual to persist.
  server.post("/admin/payment-processors/paypal/create-plan", async (req, reply) => {
    const body = z
      .object({
        planId: PlanIdEnum,
        mode: PaymentModeEnum,
      })
      .parse(req.body);
    if (body.planId === "naboria" || body.planId === "unlimited") {
      return reply.badRequest("PayPal plans are only meaningful for paid tiers");
    }

    const [row] = await db
      .select()
      .from(paymentProcessors)
      .where(eq(paymentProcessors.provider, "paypal"))
      .limit(1);
    if (!row) {
      return reply.badRequest(
        "Save PayPal credentials first, then create plans.",
      );
    }
    const creds = row.credentialsEnc
      ? (JSON.parse(decryptString(row.credentialsEnc)) as PayPalCredentialsBlob)
      : {};
    const config = row.configEnc
      ? (JSON.parse(decryptString(row.configEnc)) as PayPalConfigBlob)
      : {};

    let adapter: PayPalAdapter;
    try {
      adapter = new PayPalAdapter(body.mode, creds, config);
    } catch (err) {
      return reply.badRequest(
        `PayPal credentials incomplete for ${body.mode} mode: ${(err as Error).message}`,
      );
    }

    const [plan] = await db
      .select()
      .from(plans)
      .where(eq(plans.id, body.planId))
      .limit(1);
    if (!plan) return reply.notFound("Local plan not found");
    if (plan.priceCents <= 0) {
      return reply.badRequest("Local plan has no price configured");
    }

    try {
      const result = await adapter.createProductAndPlan({
        productName: `MobileFlow ${plan.name}`,
        planName: `${plan.name} Monthly`,
        priceCents: plan.priceCents,
        currency: plan.currency,
      });
      return result;
    } catch (err) {
      server.log.warn({ err, planId: body.planId, mode: body.mode }, "paypal plan provisioning failed");
      return reply.internalServerError(
        `Could not create PayPal plan: ${(err as Error).message}`,
      );
    }
  });

  server.delete<{ Params: { provider: string } }>(
    "/admin/payment-processors/:provider",
    async (req, reply) => {
      const providerParse = PaymentProviderEnum.safeParse(req.params.provider);
      if (!providerParse.success) return reply.badRequest("Unknown processor");
      await db
        .delete(paymentProcessors)
        .where(eq(paymentProcessors.provider, providerParse.data));
      clearActiveAdapterCache();
      return reply.code(204).send();
    },
  );

  // ---------- Payments (cross-org) ----------
  //
  // Read-only ledger view for superadmins. Joins to organizations so the UI
  // can show org name + slug without a second round-trip. PDFs are served by
  // the existing /orgs/:orgId/payments/:paymentId/{invoice,receipt}.pdf
  // endpoints — those already let superadmins through `requireOrgMember`.

  server.get("/admin/payments", async () => {
    const rows = await db
      .select({
        id: payments.id,
        orgId: payments.orgId,
        orgName: organizations.name,
        orgSlug: organizations.slug,
        paymentProvider: payments.paymentProvider,
        processorInvoiceId: payments.processorInvoiceId,
        receiptNumber: payments.receiptNumber,
        amountCents: payments.amountCents,
        currency: payments.currency,
        status: payments.status,
        planId: payments.planId,
        planName: payments.planName,
        paymentMethodType: payments.paymentMethodType,
        paymentMethodBrand: payments.paymentMethodBrand,
        paymentMethodLast4: payments.paymentMethodLast4,
        customerName: payments.customerName,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .innerJoin(organizations, eq(organizations.id, payments.orgId))
      .orderBy(desc(payments.createdAt))
      .limit(500);
    return rows;
  });

  // ---------- Company info ----------
  //
  // Singleton (id=1) holding the brand identity stamped on outgoing PDFs and
  // (later) transactional email templates. GET returns the row or `null` if
  // it hasn't been initialized yet — the page renders an empty form in that
  // case and the first save creates the row.

  server.get("/admin/company-info", async () => {
    const [row] = await db
      .select({
        id: companyInfo.id,
        name: companyInfo.name,
        legalName: companyInfo.legalName,
        supportEmail: companyInfo.supportEmail,
        salesEmail: companyInfo.salesEmail,
        logoMime: companyInfo.logoMime,
        updatedAt: companyInfo.updatedAt,
      })
      .from(companyInfo)
      .where(eq(companyInfo.id, 1))
      .limit(1);
    return row ?? null;
  });

  const LOGO_MIMES = new Set(["image/png", "image/jpeg"]);
  const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

  // Logo binary. Same auth gate as the rest of the admin endpoints — the
  // image is brand identity, not secret per se, but exposing a public URL
  // would let any visitor probe whether a deployment exists. Easier to keep
  // it behind the session cookie and have the admin page fetch it the same
  // way it fetches every other admin payload.
  server.get("/admin/company-info/logo", async (_req, reply) => {
    const [row] = await db
      .select({ logoMime: companyInfo.logoMime, logoData: companyInfo.logoData })
      .from(companyInfo)
      .where(eq(companyInfo.id, 1))
      .limit(1);
    if (!row?.logoData || !row.logoMime || !LOGO_MIMES.has(row.logoMime)) {
      return reply.notFound();
    }
    reply.header("Content-Type", row.logoMime);
    reply.header("Content-Disposition", "attachment; filename=\"company-logo\"");
    reply.header("Content-Security-Policy", "default-src 'none'");
    reply.header("Cache-Control", "no-store");
    return reply.send(row.logoData);
  });

  const LogoBody = z
    .object({
      mime: z.string().min(1).max(120),
      // Data-URL prefix is optional; the page can send `iVBOR...` raw or
      // `data:image/png;base64,iVBOR...` and we strip the prefix here.
      base64: z.string().min(1).max(8 * 1024 * 1024),
    })
    .strict();

  server.put("/admin/company-info/logo", async (req, reply) => {
    const body = LogoBody.parse(req.body);
    if (!LOGO_MIMES.has(body.mime)) {
      return reply.badRequest(
        "Unsupported image type. Use PNG or JPG.",
      );
    }
    const stripped = body.base64.replace(/^data:[^;]+;base64,/, "");
    let buf: Buffer;
    try {
      buf = Buffer.from(stripped, "base64");
    } catch {
      return reply.badRequest("Could not decode base64 payload");
    }
    if (buf.length === 0) return reply.badRequest("Empty image payload");
    if (buf.length > MAX_LOGO_BYTES) {
      return reply.badRequest(
        `Logo is too large (${Math.round(buf.length / 1024)} KB). Limit is ${MAX_LOGO_BYTES / 1024 / 1024} MB.`,
      );
    }
    // Cheap content-sniffing: PNG / JPG signatures. Catches mismatch
    // between claimed mime and actual bytes (e.g. someone renamed a .docx
    // to .png and uploaded it).
    if (!matchesMime(buf, body.mime)) {
      return reply.badRequest(
        "File contents do not match the declared image type",
      );
    }
    await db
      .insert(companyInfo)
      .values({
        id: 1,
        logoMime: body.mime,
        logoData: buf,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: companyInfo.id,
        set: { logoMime: body.mime, logoData: buf, updatedAt: new Date() },
      });
    return { ok: true, bytes: buf.length };
  });

  server.delete("/admin/company-info/logo", async () => {
    await db
      .update(companyInfo)
      .set({ logoMime: null, logoData: null, updatedAt: new Date() })
      .where(eq(companyInfo.id, 1));
    return { ok: true };
  });

  const CompanyInfoBody = z
    .object({
      name: z.string().max(120).nullable().optional(),
      legalName: z.string().max(160).nullable().optional(),
      supportEmail: z.string().email().max(160).nullable().optional(),
      salesEmail: z.string().email().max(160).nullable().optional(),
    })
    .strict();

  server.put("/admin/company-info", async (req) => {
    const body = CompanyInfoBody.parse(req.body);
    const [row] = await db
      .insert(companyInfo)
      .values({
        id: 1,
        name: body.name ?? null,
        legalName: body.legalName ?? null,
        supportEmail: body.supportEmail ?? null,
        salesEmail: body.salesEmail ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: companyInfo.id,
        set: {
          name: body.name ?? null,
          legalName: body.legalName ?? null,
          supportEmail: body.supportEmail ?? null,
          salesEmail: body.salesEmail ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  });

  // ---------- Logs ----------
  //
  // Admin log browsing is intentionally file-backed, not DB-backed. Dev and
  // production both use LOG_DIR; production should point it at a private,
  // non-web-served server directory. The routes below never accept raw paths
  // from the browser, only validated scope/year/month/file segments.

  server.get("/admin/logs/scopes", async () => listLogScopes());

  server.get<{ Params: { scope: string } }>("/admin/logs/:scope/years", async (req, reply) => {
    try {
      return await listLogYears(req.params.scope);
    } catch (err) {
      return reply.badRequest((err as Error).message);
    }
  });

  server.get<{ Params: { scope: string; year: string } }>(
    "/admin/logs/:scope/:year/months",
    async (req, reply) => {
      try {
        return await listLogMonths(req.params.scope, req.params.year);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  server.get<{ Params: { scope: string; year: string; month: string } }>(
    "/admin/logs/:scope/:year/:month/files",
    async (req, reply) => {
      try {
        return await listLogFiles(req.params.scope, req.params.year, req.params.month);
      } catch (err) {
        return reply.badRequest((err as Error).message);
      }
    },
  );

  server.get<{
    Querystring: { scope?: string; year?: string; month?: string; file?: string };
  }>("/admin/logs/file", async (req, reply) => {
    const { scope, year, month, file } = req.query;
    if (!scope || !year || !month || !file) return reply.badRequest("Missing log file selector");
    try {
      return await readLogFile(scope, year, month, file);
    } catch (err) {
      return reply.badRequest((err as Error).message);
    }
  });

  server.delete<{
    Querystring: { scope?: string; year?: string; month?: string; file?: string };
  }>("/admin/logs/file", async (req, reply) => {
    const { scope, year, month, file } = req.query;
    if (!scope || !year || !month || !file) return reply.badRequest("Missing log file selector");
    try {
      await deleteLogFile(scope, year, month, file);
      return reply.code(204).send();
    } catch (err) {
      return reply.badRequest((err as Error).message);
    }
  });

  // ---------- Stats ----------

  server.get("/admin/stats", async () => {
    const [u] = await db.select({ n: count() }).from(users);
    const [o] = await db.select({ n: count() }).from(organizations);
    const [a] = await db.select({ n: count() }).from(apps).where(isNull(apps.deletedAt));
    const [b] = await db.select({ n: count() }).from(builds);
    const [running] = await db
      .select({ n: count() })
      .from(builds)
      .where(sql`status IN ('queued','running')`);
    return {
      users: u?.n ?? 0,
      organizations: o?.n ?? 0,
      apps: a?.n ?? 0,
      builds: b?.n ?? 0,
      runningOrQueued: running?.n ?? 0,
    };
  });
}

// Deep-merge `patch` into `base`. When `dropEmpty` is true, empty-string
// leaves in `patch` are ignored (used for credentials, so blanking a secret
// field on the form doesn't wipe the stored secret). When false, empty
// strings DO overwrite — used for config (price IDs), where clearing a price
// is a meaningful action.
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  opts: { dropEmpty: boolean },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const baseV = (out[k] as Record<string, unknown> | undefined) ?? {};
      out[k] = deepMerge(baseV, v as Record<string, unknown>, opts);
    } else if (typeof v === "string") {
      if (opts.dropEmpty && v.length === 0) continue;
      out[k] = v;
    } else if (v === null) {
      out[k] = null;
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// Lightweight magic-byte check so the server doesn't trust the client-declared
// mime alone. Doesn't validate that the image is well-formed beyond the first
// few bytes — pdfkit will reject a corrupt image at render time, which is the
// right place for the heavier check.
function matchesMime(buf: Buffer, mime: string): boolean {
  if (buf.length < 4) return false;
  if (mime === "image/png") {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    );
  }
  if (mime === "image/jpeg") {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  return false;
}
