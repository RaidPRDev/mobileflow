export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// Methods that don't require a CSRF token. Mirrors the server-side allow-list
// in apps/api/src/auth/csrf.ts — if you change one, change the other.
const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_COOKIE = "mf_csrf";

function readCsrfTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  // document.cookie is the only place the SPA can read the CSRF value back —
  // the cookie is deliberately NOT httpOnly. A cross-origin attacker cannot
  // read it (same-origin policy on cookies) but can cause a credentialed
  // request to send it back; CSRF defense relies on them being unable to
  // *also* set the matching X-CSRF-Token header, which they can't.
  for (const entry of document.cookie.split(";")) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const name = entry.slice(0, eq).trim();
    if (name !== CSRF_COOKIE) continue;
    return decodeURIComponent(entry.slice(eq + 1).trim());
  }
  return null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const hasBody = init.body != null;
  const method = (init.method ?? "GET").toUpperCase();
  const needsCsrf = !CSRF_SAFE_METHODS.has(method);
  const csrfToken = needsCsrf ? readCsrfTokenFromCookie() : null;
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    const errField =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : null;
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : null;
    throw new ApiError(res.status, body, message ?? errField ?? `HTTP ${res.status}`);
  }
  return body as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

import type { Runtime } from "@mobileflow/shared";
export type { Runtime };
export type GitProvider = "github" | "gitlab" | "bitbucket";

export interface CertificateRow {
  id: string;
  appId: string;
  platform: "ios" | "android";
  kind: "p12" | "provisioning" | "keystore";
  label: string;
  fileName: string;
  metadata: Record<string, string>;
  createdAt: string;
  parentCertId: string | null;
}

export interface CertificateGroup extends CertificateRow {
  provisioningProfiles: CertificateRow[];
}

export interface EnvironmentRow {
  id: string;
  appId: string;
  name: string;
  createdAt: string;
}

export interface EnvVarRow {
  id: string;
  key: string;
  isSecret: boolean;
  value: string; // "********" for secrets
}

export interface EnvironmentWithVars extends EnvironmentRow {
  vars: EnvVarRow[];
}

export interface MeResponse {
  user: { id: string; email: string; name: string | null; isSuperadmin: boolean };
  organizations: { orgId: string; slug: string; name: string; role: "owner" | "admin" | "member" }[];
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  iconUrl: string | null;
  description: string | null;
  billingEmail: string | null;
  createdAt: string;
}

export interface BillingInfoRow {
  orgId: string;
  fullName: string | null;
  country: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  taxIdType: string | null;
  taxIdValue: string | null;
  updatedAt: string;
}

export interface PaymentMethodRow {
  type: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export interface PaymentRow {
  id: string;
  orgId: string;
  stripeInvoiceId: string;
  amountCents: number;
  currency: string;
  status: "paid" | "open" | "uncollectible" | "void" | "draft" | "failed";
  description: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface AppRow {
  id: string;
  orgId: string;
  name: string;
  iconUrl: string | null;
  runtime: Runtime;
  gitConnectionId: string | null;
  gitRepoFullName: string | null;
  gitDefaultBranch: string | null;
  createdAt: string;
}

export interface GitConnectionRow {
  id: string;
  provider: GitProvider;
  accountLogin: string;
  accountAvatarUrl: string | null;
  createdAt: string;
}

export interface RepoRow {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
}

export interface BranchRow {
  name: string;
  isDefault: boolean;
}

export interface CommitRow {
  sha: string;
  message: string;
  authorName: string;
  authorLogin: string | null;
  avatarUrl: string | null;
  date: string;
  url: string;
}

export interface CommitsPageResponse {
  items: CommitRow[];
  page: number;
  perPage: number;
  hasNext: boolean;
  totalCount: number | null;
  accountLogin: string | null;
  accountAvatarUrl: string | null;
}

export type BuildTarget = "ios" | "android" | "web";
export type BuildStatus = "queued" | "running" | "success" | "failed" | "cancelled";
export type BuildStepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export interface BuildDeploymentSummary {
  buildId: string;
  destinationId: string;
  destinationName: string | null;
  destinationType: "app_store" | "testflight" | "play_store" | "play_internal" | null;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  createdAt: string;
}

export interface BuildRow {
  id: string;
  appId: string;
  commitSha: string;
  commitMessage: string | null;
  branch: string | null;
  target: BuildTarget;
  stackId: string;
  buildType: string | null;
  environmentId: string | null;
  certificateId: string | null;
  certificateLabel: string | null;
  status: BuildStatus;
  hostId: string | null;
  errorMessage: string | null;
  artifacts: { kind: string; url: string; sizeBytes?: number }[] | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  triggeredByName?: string | null;
  triggeredByEmail?: string | null;
  autoDeployDestinationId?: string | null;
  deployments?: BuildDeploymentSummary[];
}

export interface BuildStepRow {
  id: string;
  name: string;
  status: BuildStepStatus;
  sortOrder: number;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
}

export interface BuildDetail extends Omit<BuildRow, never> {
  steps: BuildStepRow[];
  log: { offset: number; length: number; tail: string };
}

export type DeploymentStatus = "queued" | "running" | "success" | "failed" | "cancelled";
export type DestinationType = "app_store" | "testflight" | "play_store" | "play_internal";

export type DestinationConfigSummary =
  | { authMode: "altool"; appleId: string; appAppleId: string; teamId: string }
  | { authMode: "api_key"; issuerId: string; keyId: string }
  | { artifactKind: "aab" | "apk" }
  | Record<string, never>;

export interface DestinationRow {
  id: string;
  appId: string;
  name: string;
  type: DestinationType;
  bundleId: string | null;
  trackOrChannel: string | null;
  createdAt: string;
  configSummary: DestinationConfigSummary;
}

export interface DeploymentRow {
  id: string;
  buildId: string;
  destinationId: string;
  destinationName: string;
  destinationType: DestinationType;
  status: DeploymentStatus;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  triggeredByName: string | null;
  triggeredByEmail: string | null;
  buildTarget: BuildTarget;
  buildCommitSha: string;
  buildCommitMessage: string | null;
  buildBranch: string | null;
  buildCreatedAt: string;
  buildNumber: number | null;
}

export interface DeploymentDetail {
  id: string;
  buildId: string;
  destinationId: string;
  status: DeploymentStatus;
  errorMessage: string | null;
  logText: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const api = {
  signup: (input: { email: string; password: string; name?: string; organizationName?: string }) =>
    request<{ user: { id: string; email: string; name: string | null }; org: { id: string; slug: string; name: string } }>(
      "/auth/signup",
      { method: "POST", body: JSON.stringify(input) },
    ),
  login: (input: { email: string; password: string }) =>
    request<{ user: { id: string; email: string; name: string | null } }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  me: () => request<MeResponse>("/auth/me"),

  listStacks: () =>
    request<{
      id: string;
      platform: BuildTarget;
      label: string;
      image: string | null;
      isDefault: boolean;
      sortOrder: number;
    }[]>("/stacks"),

  getOrg: (orgId: string) => request<OrgRow>(`/orgs/${orgId}`),
  patchOrg: (
    orgId: string,
    body: Partial<{
      name: string;
      iconUrl: string | null;
      description: string | null;
      billingEmail: string | null;
    }>,
  ) => request<OrgRow>(`/orgs/${orgId}`, { method: "PATCH", body: JSON.stringify(body) }),

  listApps: (orgId: string) => request<AppRow[]>(`/orgs/${orgId}/apps`),
  createApp: (
    orgId: string,
    body: {
      name: string;
      runtime: Runtime;
      gitConnectionId?: string | null;
      gitRepoFullName?: string | null;
      gitDefaultBranch?: string | null;
    },
  ) => request<AppRow>(`/orgs/${orgId}/apps`, { method: "POST", body: JSON.stringify(body) }),
  getApp: (appId: string) => request<AppRow>(`/apps/${appId}`),
  patchApp: (
    appId: string,
    body: Partial<{ name: string; iconUrl: string | null; runtime: Runtime; gitConnectionId: string | null; gitRepoFullName: string | null; gitDefaultBranch: string | null }>,
  ) => request<AppRow>(`/apps/${appId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteApp: (appId: string) => request<void>(`/apps/${appId}`, { method: "DELETE" }),
  transferApp: (appId: string, targetOrgId: string) =>
    request<AppRow>(`/apps/${appId}/transfer`, {
      method: "POST",
      body: JSON.stringify({ targetOrgId }),
    }),

  listGitConnections: (orgId: string) => request<GitConnectionRow[]>(`/orgs/${orgId}/git-connections`),
  deleteGitConnection: (id: string) => request<void>(`/git-connections/${id}`, { method: "DELETE" }),
  listRepos: (connectionId: string) => request<RepoRow[]>(`/git-connections/${connectionId}/repos`),
  listBranches: (connectionId: string, fullName: string) =>
    request<BranchRow[]>(`/git-connections/${connectionId}/branches?repo=${encodeURIComponent(fullName)}`),

  listCommits: (appId: string, opts: { branch?: string; page?: number; perPage?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.branch) params.set("branch", opts.branch);
    if (opts.page) params.set("page", String(opts.page));
    if (opts.perPage) params.set("per_page", String(opts.perPage));
    const qs = params.toString();
    return request<CommitsPageResponse>(`/apps/${appId}/commits${qs ? `?${qs}` : ""}`);
  },
  getCommit: (appId: string, sha: string) =>
    request<CommitRow & { accountLogin: string | null; accountAvatarUrl: string | null }>(
      `/apps/${appId}/commits/${sha}`,
    ),

  listBuilds: (appId: string) => request<BuildRow[]>(`/apps/${appId}/builds`),
  startBuild: (
    appId: string,
    body: {
      commitSha: string;
      commitMessage?: string;
      branch?: string;
      target: BuildTarget;
      stackId: string;
      buildType?: string;
      environmentId?: string;
      certificateId?: string;
      autoDeployDestinationId?: string;
    },
  ) => request<BuildRow>(`/apps/${appId}/builds`, { method: "POST", body: JSON.stringify(body) }),
  getBuild: (buildId: string, sinceOffset = 0) =>
    request<BuildDetail>(`/builds/${buildId}?since=${sinceOffset}`),
  cancelBuild: (buildId: string) =>
    request<{ ok: true }>(`/builds/${buildId}/cancel`, { method: "POST" }),

  // Environments
  listEnvironments: (appId: string) =>
    request<EnvironmentRow[]>(`/apps/${appId}/environments`),
  listEnvironmentsWithVars: (appId: string) =>
    request<EnvironmentWithVars[]>(`/apps/${appId}/environments?include=vars`),
  createEnvironment: (appId: string, name: string) =>
    request<{ id: string; name: string }>(`/apps/${appId}/environments`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  updateEnvironment: (envId: string, body: { name: string }) =>
    request<{ id: string; name: string }>(`/environments/${envId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteEnvironment: (envId: string) =>
    request<void>(`/environments/${envId}`, { method: "DELETE" }),
  listEnvVars: (envId: string) =>
    request<EnvVarRow[]>(`/environments/${envId}/vars`),
  createEnvVar: (envId: string, body: { key: string; value: string; isSecret?: boolean }) =>
    request<EnvVarRow>(`/environments/${envId}/vars`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteEnvVar: (varId: string) => request<void>(`/env-vars/${varId}`, { method: "DELETE" }),

  // Certificates
  listCertificates: (appId: string) =>
    request<CertificateGroup[]>(`/apps/${appId}/certificates`),
  createCertificate: (
    appId: string,
    body: {
      platform: "ios" | "android";
      kind: "p12" | "provisioning" | "keystore";
      label: string;
      fileName: string;
      fileBase64: string;
      password?: string;
      metadata?: Record<string, string>;
      parentCertId?: string;
    },
  ) => request<CertificateRow>(`/apps/${appId}/certificates`, { method: "POST", body: JSON.stringify(body) }),
  updateCertificate: (
    id: string,
    body: {
      label?: string;
      password?: string | null;
      metadata?: Record<string, string>;
      fileName?: string;
      fileBase64?: string;
    },
  ) => request<CertificateRow>(`/certificates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCertificate: (id: string) => request<void>(`/certificates/${id}`, { method: "DELETE" }),

  // Deployments
  listDestinations: (appId: string) =>
    request<DestinationRow[]>(`/apps/${appId}/destinations`),
  createDestination: (
    appId: string,
    body: {
      name: string;
      type: "app_store" | "play_store";
      bundleId?: string | null;
      trackOrChannel?: string | null;
      config: Record<string, unknown>;
    },
  ) => request<unknown>(`/apps/${appId}/destinations`, { method: "POST", body: JSON.stringify(body) }),
  updateDestination: (
    id: string,
    body: {
      name?: string;
      bundleId?: string | null;
      trackOrChannel?: string | null;
      config?: Record<string, unknown>;
    },
  ) => request<DestinationRow>(`/destinations/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteDestination: (id: string) => request<void>(`/destinations/${id}`, { method: "DELETE" }),

  listDeployments: (appId: string) =>
    request<DeploymentRow[]>(`/apps/${appId}/deployments`),
  createDeployment: (appId: string, body: { buildId: string; destinationId: string }) =>
    request<{ id: string }>(`/apps/${appId}/deployments`, { method: "POST", body: JSON.stringify(body) }),
  getDeployment: (id: string) =>
    request<DeploymentDetail>(`/deployments/${id}`),

  // Billing
  getSubscription: (orgId: string) =>
    request<{
      planId: string;
      status: string;
      stripeCustomerId: string | null;
      stripeSubscriptionId: string | null;
      currentPeriodStart: string | null;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
    } | null>(`/orgs/${orgId}/subscription`),
  listBillingPlans: () =>
    request<{
      id: string;
      name: string;
      priceCents: number;
      currency: string;
      maxApps: number | null;
      maxSeats: number | null;
      maxConcurrentBuilds: number | null;
      canBuild: boolean;
      hasStripePrice: boolean;
    }[]>("/billing/plans"),
  getUsage: (orgId: string) => request<{ apps: number; runningOrQueued: number }>(`/orgs/${orgId}/usage`),
  startCheckout: (orgId: string, planId: "bohio" | "yucayeque" | "cacique") =>
    request<{ url: string }>(`/orgs/${orgId}/billing/checkout`, {
      method: "POST",
      body: JSON.stringify({ planId }),
    }),
  openBillingPortal: (orgId: string) =>
    request<{ url: string }>(`/orgs/${orgId}/billing/portal`, { method: "POST" }),

  getBillingConfig: () => request<{ publishableKey: string | null }>("/billing/config"),
  getBillingInfo: (orgId: string) =>
    request<BillingInfoRow | null>(`/orgs/${orgId}/billing-info`),
  putBillingInfo: (orgId: string, body: Partial<Omit<BillingInfoRow, "orgId" | "updatedAt">>) =>
    request<BillingInfoRow>(`/orgs/${orgId}/billing-info`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  createSetupIntent: (orgId: string) =>
    request<{ clientSecret: string }>(`/orgs/${orgId}/billing/setup-intent`, { method: "POST" }),
  getPaymentMethod: (orgId: string) =>
    request<PaymentMethodRow | null>(`/orgs/${orgId}/billing/payment-method`),
  attachPaymentMethod: (orgId: string, paymentMethodId: string) =>
    request<{ ok: true }>(`/orgs/${orgId}/billing/payment-method`, {
      method: "POST",
      body: JSON.stringify({ paymentMethodId }),
    }),
  listPayments: (orgId: string) => request<PaymentRow[]>(`/orgs/${orgId}/payments`),

  // Admin (superadmin only)
  admin: {
    stats: () =>
      request<{ users: number; organizations: number; apps: number; builds: number; runningOrQueued: number }>("/admin/stats"),
    orgs: () =>
      request<{ id: string; name: string; slug: string; ownerUserId: string; createdAt: string; planId: string | null; planStatus: string | null }[]>(
        "/admin/orgs",
      ),
    org: (id: string) =>
      request<{
        org: { id: string; name: string; slug: string; ownerUserId: string; createdAt: string };
        subscription: { planId: string; status: string } | null;
        members: { userId: string; email: string; name: string | null; role: "owner" | "admin" | "member"; isSuperadmin: boolean }[];
        apps: { id: string; name: string; runtime: string; gitRepoFullName: string | null; createdAt: string }[];
        recentBuilds: { id: string; status: string; target: string; createdAt: string; commitSha: string; appId: string }[];
      }>(`/admin/orgs/${id}`),
    setOrgPlan: (id: string, planId: string) =>
      request<{ ok: true }>(`/admin/orgs/${id}/plan`, { method: "PATCH", body: JSON.stringify({ planId }) }),
    deleteOrg: (id: string) => request<void>(`/admin/orgs/${id}`, { method: "DELETE" }),

    users: () =>
      request<{
        id: string;
        email: string;
        name: string | null;
        avatarUrl: string | null;
        isSuperadmin: boolean;
        createdAt: string;
        memberships: { orgId: string; orgName: string; role: "owner" | "admin" | "member" }[];
      }[]>("/admin/users"),
    setUser: (id: string, body: { isSuperadmin?: boolean; name?: string }) =>
      request<{ ok: true }>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    forceLogout: (id: string) =>
      request<{ ok: true }>(`/admin/users/${id}/force-logout`, { method: "POST" }),
    deleteUser: (id: string) => request<void>(`/admin/users/${id}`, { method: "DELETE" }),

    builds: () =>
      request<{
        id: string;
        status: string;
        target: string;
        stackId: string;
        commitSha: string;
        createdAt: string;
        startedAt: string | null;
        finishedAt: string | null;
        appId: string;
        appName: string;
        orgId: string;
        orgName: string;
      }[]>("/admin/builds"),

    plans: () =>
      request<{
        id: string;
        name: string;
        priceCents: number;
        currency: string;
        maxApps: number | null;
        maxSeats: number | null;
        maxConcurrentBuilds: number | null;
        canBuild: boolean;
        isInternal: boolean;
        sortOrder: number;
      }[]>("/admin/plans"),
    patchPlan: (
      id: string,
      body: Partial<{ name: string; priceCents: number; maxApps: number | null; maxSeats: number | null; maxConcurrentBuilds: number | null; canBuild: boolean; stripePriceId: string | null }>,
    ) => request<unknown>(`/admin/plans/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

    createStack: (body: {
      id: string;
      platform: BuildTarget;
      label: string;
      image?: string | null;
      isDefault?: boolean;
      sortOrder?: number;
    }) => request<unknown>("/admin/stacks", { method: "POST", body: JSON.stringify(body) }),
    patchStack: (
      id: string,
      body: Partial<{
        platform: BuildTarget;
        label: string;
        image: string | null;
        isDefault: boolean;
        sortOrder: number;
      }>,
    ) => request<unknown>(`/admin/stacks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteStack: (id: string) => request<void>(`/admin/stacks/${id}`, { method: "DELETE" }),

    hosts: () =>
      request<{
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
        source: "db" | "env";
        hasArtifactKey: boolean;
      }[]>("/admin/hosts"),
    createHost: (body: {
      name: string;
      kind: "linux_docker" | "mac";
      hostname: string;
      port: number;
      sshUser: string;
      sshKey: string;
      artifactKey?: string | null;
      remoteBase: string;
      downloadsBase: string;
      downloadsBaseUrl: string;
      toolsPath?: string | null;
      capacity?: number;
      online?: boolean;
    }) => request<unknown>("/admin/hosts", { method: "POST", body: JSON.stringify(body) }),
    patchHost: (id: string, body: Record<string, unknown>) =>
      request<unknown>(`/admin/hosts/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    deleteHost: (id: string) => request<void>(`/admin/hosts/${id}`, { method: "DELETE" }),
    testHost: (id: string) =>
      request<{ ok: boolean; exitCode?: number; output?: string; error?: string }>(`/admin/hosts/${id}/test`, {
        method: "POST",
      }),
    pushArtifactKey: (id: string, body?: { artifactKey?: string }) =>
      request<{ ok: boolean; output?: string; error?: string }>(
        `/admin/hosts/${id}/push-artifact-key`,
        { method: "POST", body: JSON.stringify(body ?? {}) },
      ),
    cleanupOrphans: (id: string, body?: { dryRun?: boolean }) =>
      request<{
        ok: boolean;
        kind?: "linux_docker" | "mac";
        remoteBase?: string | null;
        downloadsBase?: string | null;
        remoteOrphans?: string[];
        downloadOrphans?: string[];
        totalOrphans?: number;
        dryRun?: boolean;
        deleted?: number;
        deleteLog?: string;
        error?: string;
      }>(`/admin/hosts/${id}/cleanup-orphans`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),

    oauthApps: () =>
      request<{
        id: string;
        provider: "google" | "github" | "gitlab" | "bitbucket";
        kind: "signin" | "git";
        clientId: string;
        scopes: string | null;
        enabled: boolean;
        createdAt: string;
      }[]>("/admin/oauth-apps"),
    upsertOAuthApp: (body: {
      provider: "google" | "github" | "gitlab" | "bitbucket";
      kind: "signin" | "git";
      clientId: string;
      clientSecret: string;
      scopes?: string | null;
      enabled?: boolean;
    }) => request<unknown>("/admin/oauth-apps", { method: "POST", body: JSON.stringify(body) }),
    deleteOAuthApp: (id: string) => request<void>(`/admin/oauth-apps/${id}`, { method: "DELETE" }),
  },
};
