import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { oauthApps } from "../db/schema.js";
import { decryptString } from "../lib/crypto.js";
import { env } from "../env.js";

export type OAuthProviderId = "google" | "github" | "gitlab" | "bitbucket";

export interface OAuthProviderConfig {
  id: OAuthProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  clientId: string;
  clientSecret: string;
  fetchProfile: (accessToken: string) => Promise<{ subject: string; email: string | null; name: string | null; avatarUrl: string | null }>;
}

export const OAUTH_STATE_COOKIE = "mf_oauth_state";

export function newState(): string {
  return randomBytes(24).toString("base64url");
}

export function authorizeRedirectUrl(p: OAuthProviderConfig, redirectUri: string, state: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: p.scopes,
    state,
    ...extra,
  });
  return `${p.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode(p: OAuthProviderConfig, code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken?: string; raw: unknown }> {
  const body = new URLSearchParams({
    client_id: p.clientId,
    client_secret: p.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(p.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) {
    throw new Error(`OAuth token exchange failed (${p.id}): ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!json.access_token) throw new Error(`OAuth token exchange returned no access_token (${p.id})`);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, raw: json };
}

export const googleProvider = (clientId: string, clientSecret: string): OAuthProviderConfig => ({
  id: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: "openid email profile",
  clientId,
  clientSecret,
  async fetchProfile(token) {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`google userinfo failed: ${res.status}`);
    const j = (await res.json()) as { sub: string; email?: string; name?: string; picture?: string };
    return { subject: j.sub, email: j.email ?? null, name: j.name ?? null, avatarUrl: j.picture ?? null };
  },
});

export const gitlabProvider = (clientId: string, clientSecret: string, scopes: string): OAuthProviderConfig => ({
  id: "gitlab",
  authorizeUrl: "https://gitlab.com/oauth/authorize",
  tokenUrl: "https://gitlab.com/oauth/token",
  scopes,
  clientId,
  clientSecret,
  async fetchProfile(token) {
    const res = await fetch("https://gitlab.com/api/v4/user", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`gitlab /user failed: ${res.status}`);
    const j = (await res.json()) as { id: number; username: string; name: string | null; email: string | null; avatar_url: string | null };
    return { subject: String(j.id), email: j.email ?? null, name: j.name ?? j.username, avatarUrl: j.avatar_url ?? null };
  },
});

export const bitbucketProvider = (clientId: string, clientSecret: string, scopes: string): OAuthProviderConfig => ({
  id: "bitbucket",
  authorizeUrl: "https://bitbucket.org/site/oauth2/authorize",
  tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
  scopes,
  clientId,
  clientSecret,
  async fetchProfile(token) {
    const u = await fetch("https://api.bitbucket.org/2.0/user", { headers: { authorization: `Bearer ${token}` } });
    if (!u.ok) throw new Error(`bitbucket /user failed: ${u.status}`);
    const user = (await u.json()) as { uuid: string; display_name: string | null; username: string; links?: { avatar?: { href?: string } } };
    const e = await fetch("https://api.bitbucket.org/2.0/user/emails", { headers: { authorization: `Bearer ${token}` } });
    const emails = e.ok ? ((await e.json()) as { values: { email: string; is_primary: boolean; is_confirmed: boolean }[] }).values : [];
    const primary = emails.find((x) => x.is_primary && x.is_confirmed)?.email ?? null;
    return { subject: user.uuid, email: primary, name: user.display_name ?? user.username, avatarUrl: user.links?.avatar?.href ?? null };
  },
});

export const githubProvider = (clientId: string, clientSecret: string, scopes = "read:user user:email"): OAuthProviderConfig => ({
  id: "github",
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  scopes,
  clientId,
  clientSecret,
  async fetchProfile(token) {
    const [u, emails] = await Promise.all([
      fetch("https://api.github.com/user", {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      }).then((r) => (r.ok ? (r.json() as Promise<{ id: number; login: string; name: string | null; email: string | null; avatar_url: string | null }>) : Promise.reject(new Error(`github /user ${r.status}`)))),
      fetch("https://api.github.com/user/emails", {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      }).then((r) => (r.ok ? (r.json() as Promise<{ email: string; primary: boolean; verified: boolean }[]>) : [])),
    ]);
    const primary = emails.find((e) => e.primary && e.verified)?.email ?? u.email ?? null;
    return { subject: String(u.id), email: primary, name: u.name ?? u.login, avatarUrl: u.avatar_url ?? null };
  },
});

const DEFAULT_GIT_SCOPES: Record<OAuthProviderId, string> = {
  google: "openid email profile",
  github: "repo read:user",
  gitlab: "read_user read_api read_repository",
  bitbucket: "account email repository",
};
const DEFAULT_SIGNIN_SCOPES: Record<OAuthProviderId, string> = {
  google: "openid email profile",
  github: "read:user user:email",
  gitlab: "read_user",
  bitbucket: "account email",
};

/**
 * Resolve provider creds from `oauth_apps` first, then env vars.
 * `kind = "signin"` is for user authentication; `"git"` is for git connections.
 */
export async function resolveProvider(provider: OAuthProviderId, kind: "signin" | "git"): Promise<OAuthProviderConfig | null> {
  const [row] = await db
    .select()
    .from(oauthApps)
    .where(and(eq(oauthApps.provider, provider), eq(oauthApps.kind, kind), eq(oauthApps.enabled, true)))
    .limit(1);
  if (row) {
    const secret = decryptString(row.clientSecretEnc);
    const scopes = row.scopes ?? (kind === "git" ? DEFAULT_GIT_SCOPES[provider] : DEFAULT_SIGNIN_SCOPES[provider]);
    return makeProvider(provider, row.clientId, secret, scopes);
  }
  // Env fallback for the providers we previously hard-coded.
  if (provider === "google" && kind === "signin" && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return googleProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  }
  if (provider === "github" && kind === "signin" && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    return githubProvider(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET);
  }
  if (provider === "github" && kind === "git") {
    const id = env.GITHUB_GIT_CLIENT_ID || env.GITHUB_CLIENT_ID;
    const sec = env.GITHUB_GIT_CLIENT_SECRET || env.GITHUB_CLIENT_SECRET;
    if (id && sec) return githubProvider(id, sec, DEFAULT_GIT_SCOPES.github);
  }
  return null;
}

function makeProvider(p: OAuthProviderId, clientId: string, clientSecret: string, scopes: string): OAuthProviderConfig {
  switch (p) {
    case "google":
      return googleProvider(clientId, clientSecret);
    case "github":
      return githubProvider(clientId, clientSecret, scopes);
    case "gitlab":
      return gitlabProvider(clientId, clientSecret, scopes);
    case "bitbucket":
      return bitbucketProvider(clientId, clientSecret, scopes);
  }
}
