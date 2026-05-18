import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { gitConnections } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { OAUTH_STATE_COOKIE, exchangeCode, newState, resolveProvider, type OAuthProviderId } from "../auth/oauth.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { oauthLog } from "../lib/oauthLog.js";
import { env } from "../env.js";

class UpstreamError extends Error {
  constructor(
    public provider: GitProvider,
    public endpoint: string,
    public status: number,
    public bodySnippet: string,
  ) {
    super(`${provider} ${endpoint} ${status}: ${bodySnippet.slice(0, 200)}`);
  }
}

async function readBodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 600);
  } catch {
    return "";
  }
}

const GIT_PROVIDERS = ["github", "gitlab", "bitbucket"] as const;
type GitProvider = (typeof GIT_PROVIDERS)[number];
const GIT_STATE_COOKIE = "mf_git_state";
const GIT_ORG_COOKIE = "mf_git_org";
const GIT_RETURN_COOKIE = "mf_git_return";

// Same-origin path: must start with "/" but not "//" or "/\" (open-redirect guard).
const safeReturnPath = z
  .string()
  .max(200)
  .regex(/^\/(?![/\\])/)
  .optional();

interface RepoOut {
  id: string | number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

interface BranchOut {
  name: string;
  isDefault: boolean;
}

async function listRepos(provider: GitProvider, token: string): Promise<RepoOut[]> {
  if (provider === "github") {
    const out: RepoOut[] = [];
    let page = 1;
    while (page < 6) {
      const res = await fetch(`https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new UpstreamError("github", "/user/repos", res.status, await readBodySnippet(res));
      const batch = (await res.json()) as { id: number; full_name: string; private: boolean; default_branch: string; description: string | null }[];
      out.push(...batch.map((r) => ({ id: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, description: r.description })));
      if (batch.length < 100) break;
      page++;
    }
    return out;
  }
  if (provider === "gitlab") {
    const out: RepoOut[] = [];
    let page = 1;
    while (page < 6) {
      const res = await fetch(`https://gitlab.com/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at&page=${page}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new UpstreamError("gitlab", "/projects", res.status, await readBodySnippet(res));
      const batch = (await res.json()) as { id: number; path_with_namespace: string; visibility: string; default_branch: string | null; description: string | null }[];
      out.push(
        ...batch.map((r) => ({
          id: r.id,
          fullName: r.path_with_namespace,
          private: r.visibility !== "public",
          defaultBranch: r.default_branch ?? "main",
          description: r.description,
        })),
      );
      if (batch.length < 100) break;
      page++;
    }
    return out;
  }
  // bitbucket: CHANGE-2770 removed every account-wide listing endpoint
  // (/2.0/repositories?role=member, /2.0/user/permissions/workspaces, /2.0/workspaces).
  // Workspace must now be supplied explicitly. /2.0/user is still account-scoped and
  // returns the personal workspace's username — list repos there. Team/group workspaces
  // need an explicit slug; that requires a UI change and is out of scope here.
  const out: RepoOut[] = [];
  const userRes = await fetch("https://api.bitbucket.org/2.0/user", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) {
    throw new UpstreamError("bitbucket", "/2.0/user", userRes.status, await readBodySnippet(userRes));
  }
  const userJson = (await userRes.json()) as { username?: string; uuid?: string };
  const personalSlug = userJson.username ?? userJson.uuid;
  if (!personalSlug) {
    throw new UpstreamError("bitbucket", "/2.0/user", 200, "missing username/uuid");
  }
  const workspaceSlugs: string[] = [personalSlug];
  for (const slug of workspaceSlugs) {
    let url: string | null =
      `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(slug)}?pagelen=100&sort=-updated_on`;
    while (url) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        throw new UpstreamError(
          "bitbucket",
          `/2.0/repositories/${slug}`,
          res.status,
          await readBodySnippet(res),
        );
      }
      const j = (await res.json()) as {
        values: { uuid: string; full_name: string; is_private: boolean; mainbranch?: { name: string }; description: string | null }[];
        next?: string;
      };
      out.push(
        ...j.values.map((r) => ({
          id: r.uuid,
          fullName: r.full_name,
          private: r.is_private,
          defaultBranch: r.mainbranch?.name ?? "main",
          description: r.description,
        })),
      );
      url = j.next ?? null;
      if (out.length > 500) break;
    }
    if (out.length > 500) break;
  }
  return out;
}

async function listBranches(
  provider: GitProvider,
  token: string,
  fullName: string,
): Promise<BranchOut[]> {
  if (provider === "github") {
    const [owner, repo] = fullName.split("/", 2);
    if (!owner || !repo) {
      throw new UpstreamError("github", "/repos/:owner/:repo/branches", 400, "invalid repo full name");
    }
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
    // Default branch isn't on the branches listing, so fetch repo metadata in parallel.
    const [repoRes, ...pageResults] = await Promise.all([
      fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers }),
      ...[1, 2, 3, 4, 5].map((p) =>
        fetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=100&page=${p}`, { headers }),
      ),
    ]);
    if (!repoRes.ok) throw new UpstreamError("github", "/repos/:owner/:repo", repoRes.status, await readBodySnippet(repoRes));
    const repoJson = (await repoRes.json()) as { default_branch: string };
    const defaultBranch = repoJson.default_branch;
    const out: BranchOut[] = [];
    for (const res of pageResults) {
      if (!res.ok) throw new UpstreamError("github", "/repos/:owner/:repo/branches", res.status, await readBodySnippet(res));
      const batch = (await res.json()) as { name: string }[];
      out.push(...batch.map((b) => ({ name: b.name, isDefault: b.name === defaultBranch })));
      if (batch.length < 100) break;
    }
    return out;
  }
  if (provider === "gitlab") {
    const idOrPath = encodeURIComponent(fullName);
    const headers = { authorization: `Bearer ${token}` };
    const out: BranchOut[] = [];
    let page = 1;
    while (page < 6) {
      const res = await fetch(
        `https://gitlab.com/api/v4/projects/${idOrPath}/repository/branches?per_page=100&page=${page}`,
        { headers },
      );
      if (!res.ok) {
        throw new UpstreamError("gitlab", "/projects/:id/repository/branches", res.status, await readBodySnippet(res));
      }
      const batch = (await res.json()) as { name: string; default: boolean }[];
      out.push(...batch.map((b) => ({ name: b.name, isDefault: !!b.default })));
      if (batch.length < 100) break;
      page++;
    }
    return out;
  }
  // bitbucket
  const headers = { authorization: `Bearer ${token}` };
  const repoRes = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${fullName}`,
    { headers },
  );
  if (!repoRes.ok) {
    throw new UpstreamError("bitbucket", "/2.0/repositories/:full_name", repoRes.status, await readBodySnippet(repoRes));
  }
  const repoJson = (await repoRes.json()) as { mainbranch?: { name?: string } };
  const defaultBranch = repoJson.mainbranch?.name ?? null;
  const out: BranchOut[] = [];
  let url: string | null =
    `https://api.bitbucket.org/2.0/repositories/${fullName}/refs/branches?pagelen=100`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new UpstreamError(
        "bitbucket",
        "/2.0/repositories/:full_name/refs/branches",
        res.status,
        await readBodySnippet(res),
      );
    }
    const j = (await res.json()) as { values: { name: string }[]; next?: string };
    out.push(...j.values.map((b) => ({ name: b.name, isDefault: b.name === defaultBranch })));
    url = j.next ?? null;
    if (out.length > 500) break;
  }
  return out;
}

export async function gitConnectionRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId/git-connections", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    return db
      .select({
        id: gitConnections.id,
        provider: gitConnections.provider,
        accountLogin: gitConnections.accountLogin,
        accountAvatarUrl: gitConnections.accountAvatarUrl,
        createdAt: gitConnections.createdAt,
      })
      .from(gitConnections)
      .where(eq(gitConnections.orgId, req.params.orgId));
  });

  server.delete<{ Params: { id: string } }>("/git-connections/:id", async (req, reply) => {
    const [row] = await db.select().from(gitConnections).where(eq(gitConnections.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    await requireOrgMember(req, reply, row.orgId);
    if (reply.sent) return;
    await db.delete(gitConnections).where(eq(gitConnections.id, row.id));
    return reply.code(204).send();
  });

  server.get<{ Params: { id: string } }>("/git-connections/:id/repos", async (req, reply) => {
    const [row] = await db.select().from(gitConnections).where(eq(gitConnections.id, req.params.id)).limit(1);
    if (!row) return reply.notFound();
    await requireOrgMember(req, reply, row.orgId);
    if (reply.sent) return;
    try {
      const token = decryptString(row.accessTokenEnc);
      return await listRepos(row.provider as GitProvider, token);
    } catch (err) {
      const upstream = err instanceof UpstreamError ? err : null;
      const logEntry = upstream
        ? {
            connectionId: row.id,
            orgId: row.orgId,
            userId: req.auth?.userId,
            provider: upstream.provider,
            endpoint: upstream.endpoint,
            status: upstream.status,
            body: upstream.bodySnippet,
          }
        : {
            connectionId: row.id,
            orgId: row.orgId,
            userId: req.auth?.userId,
            provider: row.provider,
            error: (err as Error).message,
          };
      server.log.error({ err, ...logEntry }, "list repos failed");
      void oauthLog("list_repos_failed", logEntry);
      const detail = upstream
        ? `${upstream.provider} ${upstream.endpoint} returned ${upstream.status}: ${upstream.bodySnippet.slice(0, 300)}`
        : (err as Error).message;
      if (req.auth?.isSuperadmin) {
        return reply.internalServerError(`Could not list repositories — ${detail}`);
      }
      return reply.internalServerError("Could not list repositories");
    }
  });

  server.get<{ Params: { id: string }; Querystring: { repo?: string } }>(
    "/git-connections/:id/branches",
    async (req, reply) => {
      const [row] = await db.select().from(gitConnections).where(eq(gitConnections.id, req.params.id)).limit(1);
      if (!row) return reply.notFound();
      await requireOrgMember(req, reply, row.orgId);
      if (reply.sent) return;
      const repoSchema = z.string().min(3).max(200).regex(/^[^/\s]+\/[^\s]+$/, "expected owner/repo");
      const parsed = repoSchema.safeParse(req.query.repo);
      if (!parsed.success) return reply.badRequest("repo query param is required (owner/name)");
      try {
        const token = decryptString(row.accessTokenEnc);
        return await listBranches(row.provider as GitProvider, token, parsed.data);
      } catch (err) {
        const upstream = err instanceof UpstreamError ? err : null;
        const logEntry = upstream
          ? {
              connectionId: row.id,
              orgId: row.orgId,
              userId: req.auth?.userId,
              provider: upstream.provider,
              endpoint: upstream.endpoint,
              status: upstream.status,
              body: upstream.bodySnippet,
            }
          : {
              connectionId: row.id,
              orgId: row.orgId,
              userId: req.auth?.userId,
              provider: row.provider,
              error: (err as Error).message,
            };
        server.log.error({ err, ...logEntry }, "list branches failed");
        void oauthLog("list_branches_failed", logEntry);
        const detail = upstream
          ? `${upstream.provider} ${upstream.endpoint} returned ${upstream.status}: ${upstream.bodySnippet.slice(0, 300)}`
          : (err as Error).message;
        if (req.auth?.isSuperadmin) {
          return reply.internalServerError(`Could not list branches — ${detail}`);
        }
        return reply.internalServerError("Could not list branches");
      }
    },
  );

  server.get<{ Params: { provider: GitProvider }; Querystring: { orgId: string; returnTo?: string } }>(
    "/orgs/git-connections/:provider/start",
    async (req, reply) => {
      if (!GIT_PROVIDERS.includes(req.params.provider)) return reply.notFound();
      const orgId = z.string().uuid().parse(req.query.orgId);
      const returnTo = safeReturnPath.parse(req.query.returnTo);
      await requireOrgMember(req, reply, orgId);
      if (reply.sent) return;
      const p = await resolveProvider(req.params.provider as OAuthProviderId, "git");
      if (!p) return reply.notImplemented(`${req.params.provider} git connection is not configured`);
      const state = newState();
      const opts = { httpOnly: true, secure: env.isProd, sameSite: "lax" as const, path: "/", maxAge: 600 };
      reply.setCookie(GIT_STATE_COOKIE, state, opts);
      reply.setCookie(GIT_ORG_COOKIE, orgId, opts);
      if (returnTo) reply.setCookie(GIT_RETURN_COOKIE, returnTo, opts);
      else reply.clearCookie(GIT_RETURN_COOKIE, { path: "/" });
      const redirect = `${env.API_BASE_URL}/api/orgs/git-connections/${req.params.provider}/callback`;
      const params = new URLSearchParams({
        client_id: p.clientId,
        redirect_uri: redirect,
        scope: p.scopes,
        state,
        ...(req.params.provider === "bitbucket" ? { response_type: "code" } : {}),
      });
      // Bitbucket and GitHub require response_type for non-PKCE flows; GitLab is OK either way.
      if (req.params.provider !== "bitbucket") params.set("response_type", "code");
      return reply.redirect(`${p.authorizeUrl}?${params.toString()}`);
    },
  );

  server.get<{ Params: { provider: GitProvider }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/orgs/git-connections/:provider/callback",
    async (req, reply) => {
      if (!GIT_PROVIDERS.includes(req.params.provider)) return reply.notFound();
      const p = await resolveProvider(req.params.provider as OAuthProviderId, "git");
      if (!p) return reply.notFound();
      const stateCookie = req.cookies[GIT_STATE_COOKIE];
      const orgId = req.cookies[GIT_ORG_COOKIE];
      const returnTo = req.cookies[GIT_RETURN_COOKIE];
      reply.clearCookie(GIT_STATE_COOKIE, { path: "/" });
      reply.clearCookie(GIT_ORG_COOKIE, { path: "/" });
      reply.clearCookie(GIT_RETURN_COOKIE, { path: "/" });
      const back = (params: Record<string, string>) => {
        const base = returnTo && /^\/(?![/\\])/.test(returnTo)
          ? returnTo
          : orgId
            ? `/org/${orgId}/apps`
            : "/";
        const sep = base.includes("?") ? "&" : "?";
        const qs = new URLSearchParams(params).toString();
        return `${env.WEB_BASE_URL}${base}${qs ? sep + qs : ""}`;
      };
      if (req.query.error || !req.query.code || !req.query.state || !stateCookie || req.query.state !== stateCookie || !orgId) {
        return reply.redirect(back({ git_error: "invalid_state" }));
      }
      try {
        const redirect = `${env.API_BASE_URL}/api/orgs/git-connections/${req.params.provider}/callback`;
        const { accessToken, refreshToken } = await exchangeCode(p, req.query.code, redirect);
        const profile = await p.fetchProfile(accessToken);
        const accountLogin = profile.name ?? req.params.provider;
        const accountAvatarUrl = profile.avatarUrl;
        const accessTokenEnc = encryptString(accessToken);
        const refreshTokenEnc = refreshToken ? encryptString(refreshToken) : null;
        const [existing] = await db
          .select({ id: gitConnections.id })
          .from(gitConnections)
          .where(and(eq(gitConnections.orgId, orgId), eq(gitConnections.provider, req.params.provider)))
          .limit(1);
        if (existing) {
          await db
            .update(gitConnections)
            .set({ accountLogin, accountAvatarUrl, accessTokenEnc, refreshTokenEnc })
            .where(eq(gitConnections.id, existing.id));
        } else {
          await db.insert(gitConnections).values({
            orgId,
            provider: req.params.provider,
            accountLogin,
            accountAvatarUrl,
            accessTokenEnc,
            refreshTokenEnc,
          });
        }
        return reply.redirect(back({ git_connected: req.params.provider }));
      } catch (err) {
        server.log.error({ err }, "git connection callback failed");
        return reply.redirect(back({ git_error: "exchange_failed" }));
      }
    },
  );
}
