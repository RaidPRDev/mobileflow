import type { FastifyInstance } from "fastify";
import { count, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  apps,
  buildHosts,
  buildStacks,
  builds,
  oauthApps,
  orgMembers,
  organizations,
  plans,
  sessions,
  subscriptions,
  users,
} from "../db/schema.js";
import { requireSuperadmin } from "../auth/middleware.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { exec, linuxSshTarget, macSshTarget, uploadBase64, withSsh, type SshTarget } from "../worker/ssh.js";
import { resolveLinuxHost } from "../worker/ssh.js";
import { env } from "../env.js";

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
  server.addHook("preHandler", requireSuperadmin);

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
  });

  server.post("/admin/stacks", async (req, reply) => {
    const body = StackBody.parse(req.body);
    const [created] = await db
      .insert(buildStacks)
      .values({
        id: body.id,
        platform: body.platform,
        label: body.label,
        image: body.image ?? null,
        isDefault: body.isDefault,
        sortOrder: body.sortOrder,
      })
      .returning();
    if (!created) return reply.internalServerError();
    return reply.code(201).send(created);
  });

  server.patch<{ Params: { id: string } }>("/admin/stacks/:id", async (req, reply) => {
    const PatchStack = StackBody.partial().omit({ id: true });
    const body = PatchStack.parse(req.body);
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
