import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { apps, gitConnections } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { decryptString } from "../lib/crypto.js";

interface CommitOut {
  sha: string;
  message: string;
  authorName: string;
  authorLogin: string | null;
  avatarUrl: string | null;
  date: string;
  url: string;
}

async function fetchCommits(provider: "github" | "gitlab" | "bitbucket", repoFullName: string, token: string, branch: string | undefined, perPage: number): Promise<CommitOut[]> {
  if (provider === "github") {
    const params = new URLSearchParams({ per_page: String(perPage) });
    if (branch) params.set("sha", branch);
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/commits?${params}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`github commits ${res.status}`);
    const list = (await res.json()) as { sha: string; commit: { message: string; author: { name: string; date: string } }; author: { login: string; avatar_url: string } | null; html_url: string }[];
    return list.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      authorName: c.commit.author.name,
      authorLogin: c.author?.login ?? null,
      avatarUrl: c.author?.avatar_url ?? null,
      date: c.commit.author.date,
      url: c.html_url,
    }));
  }
  if (provider === "gitlab") {
    const projectId = encodeURIComponent(repoFullName);
    const params = new URLSearchParams({ per_page: String(perPage) });
    if (branch) params.set("ref_name", branch);
    const res = await fetch(`https://gitlab.com/api/v4/projects/${projectId}/repository/commits?${params}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`gitlab commits ${res.status}`);
    const list = (await res.json()) as { id: string; title: string; message: string; author_name: string; author_email: string; created_at: string; web_url: string }[];
    return list.map((c) => ({
      sha: c.id,
      message: c.message ?? c.title,
      authorName: c.author_name,
      authorLogin: null,
      avatarUrl: null,
      date: c.created_at,
      url: c.web_url,
    }));
  }
  // bitbucket
  const url = `https://api.bitbucket.org/2.0/repositories/${repoFullName}/commits${branch ? `/${branch}` : ""}?pagelen=${Math.min(perPage, 100)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`bitbucket commits ${res.status}`);
  const j = (await res.json()) as { values: { hash: string; message: string; author: { raw: string; user?: { display_name: string; links: { avatar: { href: string } } } }; date: string; links: { html: { href: string } } }[] };
  return j.values.map((c) => ({
    sha: c.hash,
    message: c.message,
    authorName: c.author.user?.display_name ?? c.author.raw,
    authorLogin: null,
    avatarUrl: c.author.user?.links.avatar.href ?? null,
    date: c.date,
    url: c.links.html.href,
  }));
}

export async function commitsRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { appId: string }; Querystring: { branch?: string; per_page?: string } }>(
    "/apps/:appId/commits",
    async (req, reply) => {
      const [row] = await db.select().from(apps).where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt))).limit(1);
      if (!row) return reply.notFound();
      await requireOrgMember(req, reply, row.orgId);
      if (reply.sent) return;
      if (!row.gitConnectionId || !row.gitRepoFullName) return [];
      const [conn] = await db.select().from(gitConnections).where(eq(gitConnections.id, row.gitConnectionId)).limit(1);
      if (!conn) return reply.failedDependency("Git connection missing");
      const provider = conn.provider as "github" | "gitlab" | "bitbucket";
      try {
        const token = decryptString(conn.accessTokenEnc);
        return await fetchCommits(provider, row.gitRepoFullName, token, req.query.branch, Number(req.query.per_page ?? 30));
      } catch (err) {
        server.log.warn({ err, provider }, "fetch commits failed");
        return reply.badGateway("Failed to fetch commits");
      }
    },
  );
}
