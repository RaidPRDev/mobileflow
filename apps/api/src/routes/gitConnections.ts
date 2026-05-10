import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { gitConnections } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { OAUTH_STATE_COOKIE, exchangeCode, newState, resolveProvider, type OAuthProviderId } from "../auth/oauth.js";
import { decryptString, encryptString } from "../lib/crypto.js";
import { env } from "../env.js";

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

async function listRepos(provider: GitProvider, token: string): Promise<RepoOut[]> {
  if (provider === "github") {
    const out: RepoOut[] = [];
    let page = 1;
    while (page < 6) {
      const res = await fetch(`https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`github /user/repos ${res.status}`);
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
      if (!res.ok) throw new Error(`gitlab /projects ${res.status}`);
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
  // bitbucket
  const out: RepoOut[] = [];
  let url: string | null = "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100&sort=-updated_on";
  while (url) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`bitbucket /repositories ${res.status}`);
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
      server.log.error({ err }, "list repos failed");
      return reply.internalServerError("Could not list repositories");
    }
  });

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
