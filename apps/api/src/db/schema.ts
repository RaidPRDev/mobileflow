import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { RUNTIME_IDS } from "@mobileflow/shared";

export const orgRole = pgEnum("org_role", ["owner", "admin", "member"]);
export const ssoProvider = pgEnum("sso_provider", ["google", "github"]);
export const gitProvider = pgEnum("git_provider", ["github", "gitlab", "bitbucket"]);
export const oauthAppKind = pgEnum("oauth_app_kind", ["signin", "git"]);
export const oauthAppProvider = pgEnum("oauth_app_provider", ["google", "github", "gitlab", "bitbucket"]);
export const appRuntime = pgEnum("app_runtime", RUNTIME_IDS);
export const buildTarget = pgEnum("build_target", ["ios", "android", "web"]);
export const buildStatus = pgEnum("build_status", [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
]);
export const buildStepStatus = pgEnum("build_step_status", [
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
]);
export const certPlatform = pgEnum("cert_platform", ["ios", "android"]);
export const certKind = pgEnum("cert_kind", ["p12", "provisioning", "keystore"]);
export const buildHostKind = pgEnum("build_host_kind", ["linux_docker", "mac"]);
export const storeDestinationType = pgEnum("store_destination_type", [
  "app_store",
  "testflight",
  "play_store",
  "play_internal",
]);
export const deploymentStatus = pgEnum("deployment_status", [
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
]);
export const buildType = pgEnum("build_type", [
  "debug",
  "release",
  "development",
  "adhoc",
  "appstore",
]);
export const planId = pgEnum("plan_id", [
  "naboria",
  "bohio",
  "yucayeque",
  "cacique",
  "unlimited",
]);
export const subscriptionStatus = pgEnum("subscription_status", [
  "active",
  "trialing",
  "past_due",
  "canceled",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  avatarUrl: text("avatar_url"),
  isSuperadmin: boolean("is_superadmin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const orgMembers = pgTable(
  "org_members",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: orgRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orgId, t.userId] }),
  }),
);

export const ssoIdentities = pgTable(
  "sso_identities",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: ssoProvider("provider").notNull(),
    subject: text("subject").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.subject] }),
  }),
);

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(), // opaque random id; we hash it before lookup if needed
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
});

export const plans = pgTable("plans", {
  id: planId("id").primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  maxApps: integer("max_apps"), // null = unlimited
  maxSeats: integer("max_seats"),
  maxConcurrentBuilds: integer("max_concurrent_builds"),
  canBuild: boolean("can_build").notNull().default(true),
  stripePriceId: text("stripe_price_id"),
  isInternal: boolean("is_internal").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: "cascade" }),
  planId: planId("plan_id").notNull(),
  status: subscriptionStatus("status").notNull().default("active"),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`),
});

export const apps = pgTable("apps", {
  id: text("id").primaryKey(), // 8-char short id
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  iconUrl: text("icon_url"),
  runtime: appRuntime("runtime").notNull(),
  gitConnectionId: uuid("git_connection_id"),
  gitRepoFullName: text("git_repo_full_name"),
  gitDefaultBranch: text("git_default_branch"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const gitConnections = pgTable("git_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  provider: gitProvider("provider").notNull(),
  accountLogin: text("account_login").notNull(),
  accountAvatarUrl: text("account_avatar_url"),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const certificates = pgTable("certificates", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  platform: certPlatform("platform").notNull(),
  kind: certKind("kind").notNull(),
  // Provisioning profiles point at their parent p12 here. Top-level certs
  // (p12, keystore) have parentCertId = null.
  parentCertId: uuid("parent_cert_id"),
  label: text("label").notNull(),
  fileName: text("file_name").notNull(),
  fileBlobEnc: text("file_blob_enc").notNull(), // base64-encoded encrypted blob (AES-256-GCM)
  passwordEnc: text("password_enc"),
  metadata: jsonb("metadata").$type<Record<string, string>>().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthApps = pgTable(
  "oauth_apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: oauthAppProvider("provider").notNull(),
    kind: oauthAppKind("kind").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEnc: text("client_secret_enc").notNull(),
    scopes: text("scopes"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uniq: unique("oauth_apps_provider_kind_unique").on(t.provider, t.kind) }),
);

export const buildHosts = pgTable("build_hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: buildHostKind("kind").notNull(),
  hostname: text("hostname").notNull(),
  port: integer("port").notNull().default(22),
  sshUser: text("ssh_user").notNull(),
  sshKeyEnc: text("ssh_key_enc").notNull(), // PEM private key, encrypted
  remoteBase: text("remote_base").notNull(),
  downloadsBase: text("downloads_base").notNull(),
  downloadsBaseUrl: text("downloads_base_url").notNull(),
  toolsPath: text("tools_path"), // android tools dir for linux_docker, MAC_BUILD_TOOLS for mac
  capacity: integer("capacity").notNull().default(2),
  online: boolean("online").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const buildStacks = pgTable("build_stacks", {
  id: text("id").primaryKey(),
  platform: buildTarget("platform").notNull(),
  label: text("label").notNull(),
  imageOrXcodeVersion: text("image_or_xcode_version"),
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const environments = pgTable("environments", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const environmentVars = pgTable("environment_vars", {
  id: uuid("id").primaryKey().defaultRandom(),
  environmentId: uuid("environment_id")
    .notNull()
    .references(() => environments.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  valueEnc: text("value_enc").notNull(),
  isSecret: boolean("is_secret").notNull().default(false),
});

export const builds = pgTable("builds", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  commitSha: text("commit_sha").notNull(),
  commitMessage: text("commit_message"),
  branch: text("branch"),
  target: buildTarget("target").notNull(),
  stackId: text("stack_id")
    .notNull()
    .references(() => buildStacks.id, { onDelete: "restrict" }),
  buildType: buildType("build_type"),
  environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "set null" }),
  certificateId: uuid("certificate_id").references(() => certificates.id, { onDelete: "set null" }),
  status: buildStatus("status").notNull().default("queued"),
  hostId: text("host_id"),
  logText: text("log_text").notNull().default(""),
  errorMessage: text("error_message"),
  artifacts: jsonb("artifacts").$type<{ kind: string; url: string; sizeBytes?: number }[]>().default(sql`'[]'::jsonb`),
  // If set, the worker queues a deployment to this destination once the build
  // succeeds. Null means no auto-deploy.
  autoDeployDestinationId: uuid("auto_deploy_destination_id"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const buildSteps = pgTable("build_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  buildId: uuid("build_id")
    .notNull()
    .references(() => builds.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: buildStepStatus("status").notNull().default("pending"),
  sortOrder: integer("sort_order").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  exitCode: integer("exit_code"),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type App = typeof apps.$inferSelect;
export type GitConnection = typeof gitConnections.$inferSelect;
export type Build = typeof builds.$inferSelect;
export type BuildStep = typeof buildSteps.$inferSelect;
export type Environment = typeof environments.$inferSelect;
export type EnvironmentVar = typeof environmentVars.$inferSelect;
export type Certificate = typeof certificates.$inferSelect;
export type BuildHost = typeof buildHosts.$inferSelect;

export const storeDestinations = pgTable("store_destinations", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: text("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: storeDestinationType("type").notNull(),
  bundleId: text("bundle_id"), // iOS bundle id / Android applicationId
  trackOrChannel: text("track_or_channel"), // play_store track ("internal", "alpha", "production"), iOS lane
  configEnc: text("config_enc").notNull(), // encrypted JSON: API keys, service-account JSON, etc.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const deployments = pgTable("deployments", {
  id: uuid("id").primaryKey().defaultRandom(),
  buildId: uuid("build_id")
    .notNull()
    .references(() => builds.id, { onDelete: "cascade" }),
  destinationId: uuid("destination_id")
    .notNull()
    .references(() => storeDestinations.id, { onDelete: "cascade" }),
  status: deploymentStatus("status").notNull().default("queued"),
  logText: text("log_text").notNull().default(""),
  errorMessage: text("error_message"),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export type StoreDestination = typeof storeDestinations.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
