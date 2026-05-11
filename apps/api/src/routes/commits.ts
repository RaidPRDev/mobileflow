import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { apps, gitConnections } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { resolveProvider, type OAuthProviderId } from "../auth/oauth.js";
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

interface CommitsPage {
  items: CommitOut[];
  page: number;
  perPage: number;
  hasNext: boolean;
  totalCount: number | null;
  accountLogin: string | null;
  accountAvatarUrl: string | null;
}

// Parse a Link header and extract `page` numbers keyed by rel.
// e.g. Link: <https://api.github.com/...?page=2>; rel="next", <...?page=20>; rel="last"
function parseLinkHeader(value: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value) return out;
  for (const part of value.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
    if (!match) continue;
    try {
      const url = new URL(match[1]!);
      const p = Number(url.searchParams.get("page"));
      if (Number.isFinite(p)) out[match[2]!] = p;
    } catch {
      // ignore malformed link
    }
  }
  return out;
}

async function fetchCommits(
  provider: "github" | "gitlab" | "bitbucket",
  repoFullName: string,
  token: string,
  branch: string | undefined,
  page: number,
  perPage: number,
): Promise<CommitsBatch> {
  if (provider === "github") {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (branch) params.set("sha", branch);
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/commits?${params}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`github commits ${res.status}`);
    const list = (await res.json()) as { sha: string; commit: { message: string; author: { name: string; date: string } }; author: { login: string; avatar_url: string } | null; html_url: string }[];
    const items = list.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      authorName: c.commit.author.name,
      authorLogin: c.author?.login ?? null,
      avatarUrl: c.author?.avatar_url ?? null,
      date: c.commit.author.date,
      url: c.html_url,
    }));
    const links = parseLinkHeader(res.headers.get("link"));
    const lastPage = links.last ?? page;
    const hasNext = !!links.next;
    // GitHub doesn't expose an exact count cheaply; approximate from last page index.
    const totalCount = hasNext ? lastPage * perPage : (page - 1) * perPage + items.length;
    return { items, page, perPage, hasNext, totalCount };
  }
  if (provider === "gitlab") {
    const projectId = encodeURIComponent(repoFullName);
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (branch) params.set("ref_name", branch);
    const res = await fetch(`https://gitlab.com/api/v4/projects/${projectId}/repository/commits?${params}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`gitlab commits ${res.status}`);
    const list = (await res.json()) as { id: string; title: string; message: string; author_name: string; author_email: string; created_at: string; web_url: string }[];
    const items = list.map((c) => ({
      sha: c.id,
      message: c.message ?? c.title,
      authorName: c.author_name,
      authorLogin: null,
      avatarUrl: null,
      date: c.created_at,
      url: c.web_url,
    }));
    const totalHeader = res.headers.get("x-total");
    const nextPage = res.headers.get("x-next-page");
    const totalCount = totalHeader ? Number(totalHeader) : null;
    return { items, page, perPage, hasNext: !!nextPage, totalCount: Number.isFinite(totalCount) ? totalCount : null };
  }
  // bitbucket
  const params = new URLSearchParams({ pagelen: String(Math.min(perPage, 100)), page: String(page) });
  const url = `https://api.bitbucket.org/2.0/repositories/${repoFullName}/commits${branch ? `/${branch}` : ""}?${params}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`bitbucket commits ${res.status}`);
  const j = (await res.json()) as {
    values: { hash: string; message: string; author: { raw: string; user?: { display_name: string; links: { avatar: { href: string } } } }; date: string; links: { html: { href: string } } }[];
    next?: string;
    size?: number;
  };
  const items = j.values.map((c) => ({
    sha: c.hash,
    message: c.message,
    authorName: c.author.user?.display_name ?? c.author.raw,
    authorLogin: null,
    avatarUrl: c.author.user?.links.avatar.href ?? null,
    date: c.date,
    url: c.links.html.href,
  }));
  return { items, page, perPage, hasNext: !!j.next, totalCount: typeof j.size === "number" ? j.size : null };
}

type CommitsBatch = Pick<CommitsPage, "items" | "page" | "perPage" | "hasNext" | "totalCount">;

async function fetchCommit(
  provider: "github" | "gitlab" | "bitbucket",
  repoFullName: string,
  token: string,
  sha: string,
): Promise<CommitOut | null> {
  if (provider === "github") {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/commits/${sha}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`github commit ${res.status}`);
    const c = (await res.json()) as { sha: string; commit: { message: string; author: { name: string; date: string } }; author: { login: string; avatar_url: string } | null; html_url: string };
    return {
      sha: c.sha,
      message: c.commit.message,
      authorName: c.commit.author.name,
      authorLogin: c.author?.login ?? null,
      avatarUrl: c.author?.avatar_url ?? null,
      date: c.commit.author.date,
      url: c.html_url,
    };
  }
  if (provider === "gitlab") {
    const projectId = encodeURIComponent(repoFullName);
    const res = await fetch(`https://gitlab.com/api/v4/projects/${projectId}/repository/commits/${sha}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gitlab commit ${res.status}`);
    const c = (await res.json()) as { id: string; title: string; message: string; author_name: string; created_at: string; web_url: string };
    return {
      sha: c.id,
      message: c.message ?? c.title,
      authorName: c.author_name,
      authorLogin: null,
      avatarUrl: null,
      date: c.created_at,
      url: c.web_url,
    };
  }
  const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${repoFullName}/commit/${sha}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`bitbucket commit ${res.status}`);
  const c = (await res.json()) as { hash: string; message: string; author: { raw: string; user?: { display_name: string; links: { avatar: { href: string } } } }; date: string; links: { html: { href: string } } };
  return {
    sha: c.hash,
    message: c.message,
    authorName: c.author.user?.display_name ?? c.author.raw,
    authorLogin: null,
    avatarUrl: c.author.user?.links.avatar.href ?? null,
    date: c.date,
    url: c.links.html.href,
  };
}

export async function commitsRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { appId: string }; Querystring: { branch?: string; per_page?: string; page?: string } }>(
    "/apps/:appId/commits",
    async (req, reply) => {
      const [row] = await db.select().from(apps).where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt))).limit(1);
      if (!row) return reply.notFound();
      await requireOrgMember(req, reply, row.orgId);
      if (reply.sent) return;
      const perPage = Math.max(1, Math.min(100, Number(req.query.per_page ?? 30) || 30));
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const empty: CommitsPage = {
        items: [],
        page,
        perPage,
        hasNext: false,
        totalCount: 0,
        accountLogin: null,
        accountAvatarUrl: null,
      };
      if (!row.gitConnectionId || !row.gitRepoFullName) return empty;
      const [conn] = await db.select().from(gitConnections).where(eq(gitConnections.id, row.gitConnectionId)).limit(1);
      if (!conn) return reply.failedDependency("Git connection missing");
      const provider = conn.provider as "github" | "gitlab" | "bitbucket";
      try {
        const token = decryptString(conn.accessTokenEnc);
        // Heal connections created before account_avatar_url existed by re-fetching their profile once.
        let accountAvatarUrl = conn.accountAvatarUrl;
        if (!accountAvatarUrl) {
          try {
            const p = await resolveProvider(provider as OAuthProviderId, "git");
            if (p) {
              const profile = await p.fetchProfile(token);
              if (profile.avatarUrl) {
                accountAvatarUrl = profile.avatarUrl;
                await db
                  .update(gitConnections)
                  .set({ accountAvatarUrl })
                  .where(eq(gitConnections.id, conn.id));
              }
            }
          } catch (err) {
            server.log.warn({ err, provider }, "fetch git profile for avatar failed");
          }
        }
        const batch = await fetchCommits(provider, row.gitRepoFullName, token, req.query.branch, page, perPage);
        const out: CommitsPage = {
          ...batch,
          accountLogin: conn.accountLogin ?? null,
          accountAvatarUrl,
        };
        return out;
      } catch (err) {
        server.log.warn({ err, provider }, "fetch commits failed");
        return reply.badGateway("Failed to fetch commits");
      }
    },
  );

  server.get<{ Params: { appId: string; sha: string } }>(
    "/apps/:appId/commits/:sha",
    async (req, reply) => {
      const [row] = await db.select().from(apps).where(and(eq(apps.id, req.params.appId), isNull(apps.deletedAt))).limit(1);
      if (!row) return reply.notFound();
      await requireOrgMember(req, reply, row.orgId);
      if (reply.sent) return;
      if (!row.gitConnectionId || !row.gitRepoFullName) return reply.notFound();
      const [conn] = await db.select().from(gitConnections).where(eq(gitConnections.id, row.gitConnectionId)).limit(1);
      if (!conn) return reply.failedDependency("Git connection missing");
      const provider = conn.provider as "github" | "gitlab" | "bitbucket";
      try {
        const token = decryptString(conn.accessTokenEnc);
        const commit = await fetchCommit(provider, row.gitRepoFullName, token, req.params.sha);
        if (!commit) return reply.notFound();
        return {
          ...commit,
          accountLogin: conn.accountLogin ?? null,
          accountAvatarUrl: conn.accountAvatarUrl ?? null,
        };
      } catch (err) {
        server.log.warn({ err, provider }, "fetch single commit failed");
        return reply.badGateway("Failed to fetch commit");
      }
    },
  );
}
