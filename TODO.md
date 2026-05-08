# MobileFlow — Build Plan & TODO

A cloud build/deploy platform (Ionic Appflow-style) for Capacitor, Cordova, React Native, iOS Native, and Android Native. Front end is a Tauri + React app that doubles as a website. Back end is Node/Postgres with a build pipeline that delegates Android/Web to a Linux Docker host and iOS to a Mac (NoMachine/SSH).

> **Status snapshot** — the alpha is functional end-to-end:
> monorepo ✅, Tauri desktop ✅, API + DB + sessions ✅, Google/GitHub sign-in ✅,
> apps + multi-provider git connections (GitHub/GitLab/Bitbucket) ✅, commits ✅,
> live builds with WS log streaming ✅, real Linux Android + Linux Web + Mac iOS runners ✅,
> environments + signing certs ✅, store destinations + deployments with real
> `xcrun altool` and Google Play Publisher API runners ✅, Stripe Checkout +
> Customer Portal + webhooks ✅, superadmin console (orgs/users/builds/hosts/plans/oauth-apps) ✅.
> **Not yet:** swarm deployment to `mobileflow.raidpr.com`, audit log writes, signed
> artifact URLs, app-level Settings UI (icon/transfer/delete), webhooks-from-providers,
> usage rollup cron, ESLint/Prettier/Husky.

---

## 1. Review of reference scripts (`References/XBuildApi/xbuild`)

**What works well**
- `uploadAndBuildAndroid.sh` is solid: builds a Docker image once, mounts a Gradle cache volume, runs the build, copies AAB/APK to a downloads dir served by a Swarm stack. Cache reuse + idempotent tool sync is the right shape.
- iOS path is correct in spirit: zip → scp → unzip → run `main_build.sh` on the Mac with cert/profile parameters.
- `.env`-driven config keeps secrets out of the scripts.

**Issues / things to change for production**
1. **`sshpass` + plaintext password for the Mac.** Brittle and unsafe. Switch to SSH key auth on the Mac VM (`~/.ssh/authorized_keys`). NoMachine doesn't block SSH key login.
2. **Single global `CLIENT_ID` / `BUILD_ID` from `.env`.** Fine for a CLI; useless for multi-tenant. Every build must pass these as arguments from the orchestrator, not read from a shared `.env`.
3. **No streaming logs back to the user.** Today the script prints to stdout. The web UI needs live logs — capture stdout/stderr of every remote step into a per-build log file and tail it over WebSocket/SSE.
4. **No structured status.** Wrap each step in a JSON status emitter (`{step, status, startedAt, endedAt, exitCode}`) and ship to the API so the UI can render the build pipeline progress.
5. **Secrets baked into env on the build host.** Move keystores/p12/provisioning profiles into encrypted storage (e.g. server-side AES-GCM, per-org KMS later) and materialize them only into the per-build sandbox dir, deleted on dispose.
6. **`zip` upload of the whole project.** Replace with `git clone --depth 1 --branch <ref>` directly on the build host using a short-lived OAuth token from the connected git provider. Avoids round-tripping the source through our orchestrator and removes the "user has the project locally" assumption.
7. **No concurrency control.** A single Mac VM building two iOS jobs at once will fight over the keychain. Add a per-host job queue (BullMQ / pg-boss) with a configurable parallelism per stack.
8. **`docker stack deploy` for the file server is a side-effect of a build script.** Move that to provisioning/infra; builds shouldn't ensure infra each run.
9. **Cleanup on failure path is incomplete** in iOS script. Always run dispose in a `trap`.
10. **No artifact retention policy.** Add TTL + signed download URLs (don't expose `xbuilds.raidpr.com/<client>/<build>/...` openly).

**Recommended pipeline shape (per build)**
```
queued → preparing (clone repo, materialize secrets)
       → installing (npm ci / pod install / gradle deps)
       → building (xcodebuild / gradle / capacitor sync)
       → signing
       → packaging (ipa / aab / apk / dSYM / xcarchive)
       → publishing (upload to artifact store, sign URLs)
       → cleanup
       → success | failed | cancelled
```
Each step emits start/end events; logs are appended to `builds/<id>/log.txt` and streamed.

---

## 2. Architecture

### 2.1 Repos / packages (monorepo, pnpm workspaces)
```
apps/
  web/          # React + RSPack + LESS — the UI (also embedded by Tauri)
  desktop/      # Tauri shell wrapping apps/web
  api/          # Node (Fastify) — REST + WebSocket
  worker/       # Build orchestrator — pulls jobs, drives SSH/Docker
packages/
  ui/           # Shared React components, theme tokens
  shared/       # TS types, zod schemas, shared utils
  build-scripts/ # Ported/cleaned versions of xbuild shell scripts
infra/
  docker/       # Dockerfiles for api, worker, builders
  migrations/   # Postgres migrations (drizzle or knex)
```

### 2.2 Stack choices
- **Frontend**: React + RSPack, Zustand (or Redux Toolkit) for state, TanStack Query for server state, react-router. Theming via CSS variables + `data-theme="light|dark"` on `<html>`; "System" follows `prefers-color-scheme`.
- **UI components**: [shadcn/ui](https://ui.shadcn.com/docs/components) as the base — Radix primitives + Tailwind, copied into `packages/ui/src/base/`. Every shadcn primitive is wrapped in our own `packages/ui/src/<Component>.tsx` with our props API and design tokens, so app code only ever imports from `@mobileflow/ui`, not from the shadcn-generated files. This keeps room to swap or restyle the base later without touching app code.
  - shadcn requires Tailwind, so the LESS-only plan is out: we use Tailwind + CSS variables for tokens, with LESS available for any one-off complex styling that fights Tailwind.
  - Theme tokens (light/dark) live in a single CSS variables sheet driven by `data-theme`; shadcn primitives consume the same tokens.
- **Desktop**: Tauri 2 wrapping the same `apps/web` build. Tauri only adds: deep links for OAuth callbacks, native file save dialog for artifact downloads, secure credential store for tokens. **Yes, this is doable** — same React bundle is loaded by Tauri's webview and served by the website; conditional features behind `if (window.__TAURI__)`.
- **Backend**: Fastify + TypeScript, Postgres (Drizzle ORM), pg-boss for job queue (Postgres-backed, no Redis dep for v1), WebSocket via `@fastify/websocket` for live logs.
- **Auth**: email+password (argon2) + SSO (Google, GitHub) via OIDC. Session cookies for web, PAT tokens for desktop+CLI. (Apple deferred.)
- **Storage**: artifacts on the same server initially under `/var/mobileflow/artifacts/<orgId>/<appId>/<buildId>/`, served by an internal nginx with signed URLs. S3-compatible adapter behind an interface so we can swap to R2/S3 later.
- **Secrets**: per-org symmetric key in Postgres encrypted with a server master key from env; values (keystores, p12, env vars marked secret) encrypted at rest, decrypted only into the build sandbox.

### 2.3 Build hosts
- **Linux Docker host** (existing `89.117.17.43`): Android + Web builds via Docker images (`raidx-android-builder`, `raidx-web-builder`).
- **Mac VM(s)** (existing NoMachine host, future: configurable pool): iOS builds. Each host registered in DB with capacity, current load, capabilities (Xcode versions = "build stacks").
- **Worker process** dispatches jobs by capability matching, holds a per-host semaphore.

---

## 3. Data model (Postgres, draft)

```
organizations         (id uuid pk, name, slug, created_at, owner_user_id)
users                 (id uuid pk, email unique, password_hash, name, avatar_url,
                       is_superadmin bool default false, ...)
org_members           (org_id, user_id, role: owner|admin|member, PK (org_id,user_id))
sso_identities        (user_id, provider: google|github|apple, subject, email)

apps                  (id char(8) pk, org_id, name, icon_url, runtime: capacitor|cordova|react_native|ios_native|android_native,
                       git_provider: github|gitlab|bitbucket|null, git_repo_full_name, git_default_branch,
                       created_at, deleted_at)

git_connections       (id, org_id, provider, account_login, access_token_enc, refresh_token_enc, expires_at)
                      -- one per (org, provider); used to list repos and clone

environments          (id, app_id, name, created_at)
environment_vars      (id, environment_id, key, value_enc, is_secret bool)

certificates          (id, org_id, platform: ios|android, kind: p12|provisioning|keystore,
                       label, file_blob_enc, password_enc, metadata_json, created_at)

build_stacks          (id, platform: ios|android|web, label, image_or_xcode_version, default bool)

builds                (id uuid pk, app_id, commit_sha, commit_message, branch,
                       target: ios|android|web, stack_id, build_type: development|adhoc|appstore|debug|release,
                       environment_id null, status: queued|running|success|failed|cancelled,
                       host_id null, created_by, created_at, started_at, finished_at,
                       artifacts jsonb, log_path)

build_steps           (id, build_id, name, status, started_at, ended_at, exit_code)

store_destinations    (id, app_id, platform, type: app_store|testflight|play_store|play_internal,
                       config_enc jsonb)  -- API keys, bundle ids, tracks

deployments           (id, build_id, destination_id, status, logs, created_at)

audit_log             (id, org_id, actor_user_id, action, target, meta jsonb, created_at)

plans                 (id text pk: naboria|bohio|yucayeque|cacique|unlimited, name, price_cents, currency,
                       max_apps int null, max_seats int null, max_concurrent_builds int null,
                       can_build bool, stripe_price_id null, sort_order, is_internal bool default false)
                      -- null limits = unlimited; `unlimited` plan is_internal=true, never shown in pricing UI

subscriptions         (id, org_id, plan_id, status: active|trialing|past_due|canceled,
                       stripe_customer_id, stripe_subscription_id,
                       current_period_start, current_period_end, cancel_at_period_end bool)

usage_counters        (org_id, period_start, period_end,
                       build_minutes int, builds_succeeded int, builds_failed int)
                      -- aggregated rollups; live "in-flight" counts come from builds table
```
URL shape matches the spec: `/org/<orgId>/apps`, `/app/<shortAppId>/commits|builds|deploy|settings`.

---

## 4. UI breakdown (mapped to screenshots)

- **Auth**: `/login` — SSO buttons (Google, GitHub), email/org-id field, Continue → reveal password field, submit. Forgot password, sign-up flows.
- **Shell**: 64px outer left rail (org/app switcher, top-level icons) + 230px inner left rail (context nav). Routes:
  - Org scope: Apps, Settings (Account, Subscriptions, Usage).
  - App scope: Commits, Builds (Builds, Environments, Signing Certificates), Deploy (Deployments, Store Destinations), Settings.
- **Org Settings → Account**: profile name/email, change password, linked SSO providers (Google/GitHub) connect & disconnect, delete account.
- **Org Settings → Subscriptions**: current plan card, plan comparison grid (Naboria / Bohío / Yucayeque / Cacique), upgrade/downgrade via Stripe Checkout, manage payment method via Stripe Customer Portal, invoices list.
- **Org Settings → Usage**: current period counts vs. plan limits — apps used / total, seats used / total, concurrent builds in use / max, build minutes this period.
- **Apps list**: cards/rows of apps + "New App" dropdown (Create from template — disabled in alpha; Import App).
- **Import App** wizard: name → runtime → git host (Github/Gitlab/Bitbucket) → repo picker (or "Connect git host later") → land on Builds.
- **Git connect**: tabs per provider, OAuth flow, repo list with connect/disconnect, pre/post-connect empty states.
- **Commits**: list of recent commits for connected repo with "Start build" CTA.
- **Create build**: target (iOS/Android/Web) → stack → build type (none for Web) → environment (optional) → Build.
- **Live build view**: pipeline steps with status pills, streaming logs panel, artifacts panel (download AAB/APK/IPA/dSYM/xcarchive when ready).
- **Environments**: list + "New environment" → key/value editor with secret toggle.
- **Signing Certificates**: list + "Add certificate" modal with iOS (p12 + provisioning) and Android (keystore + alias + passwords) variants.
- **Deploy → Deployments**: list, "Create new deployment" picker (build × destination).
- **Deploy → Store Destinations**: list + "New store destination" with iOS/Android type-specific fields.
- **Settings → General**: app icon, rename, delete, transfer ownership (enter target org ID).
- **Theme**: Light / Dark / System toggle in user menu.

---

## 5. Phased TODO

### Phase 0 — Foundations
- [x] Initialize pnpm monorepo with workspaces above
- [ ] Set up TypeScript, ESLint, Prettier, Husky + lint-staged _(TS done; ESLint/Prettier/Husky not yet)_
- [x] `apps/web`: RSPack + React + Tailwind + theme tokens (light/dark/system) via CSS variables on `data-theme`
- [x] `packages/ui`: install shadcn/ui CLI, generate base primitives into `src/base/` _(Button, Input, Label, Card generated; Dialog/DropdownMenu/Tabs/Table/Toast/Tooltip/Sheet/Badge/Avatar/Select/Form/Separator/ScrollArea/Skeleton/Progress still to add as the app needs them)_
- [x] Wrap each shadcn base in our own component at `packages/ui/src/<Component>.tsx` with our prop API + tokens; export only the wrappers from the package barrel — app code must NOT import from `src/base/` directly
- [ ] App-specific composites in `packages/ui` (Sidebar, EmptyState, StatusPill, LogStream, FileDrop) built from the wrappers _(currently inline in apps/web; promote when reused)_
- [ ] ESLint rule (`no-restricted-imports`) blocking imports from `@mobileflow/ui/base/*` outside the package itself
- [x] `apps/desktop`: Tauri 2 shell loading `apps/web` build; dev script that runs RSPack + Tauri together
- [ ] Build/deploy scripts:
  - [x] `pnpm build:web` → static bundle _(via `pnpm --filter @mobileflow/web build`)_
  - [ ] `pnpm deploy:web` → rsync/scp bundle to web server, atomic swap
  - [x] `pnpm build:desktop` → Tauri installers (Windows .msi, macOS .dmg, Linux .AppImage) _(via `pnpm --filter @mobileflow/desktop build`)_

### Phase 1 — API + DB skeleton
- [x] `apps/api` Fastify scaffold, healthcheck, error handling, request logging
- [x] Postgres + Drizzle, migrations runner, connection from `DATABASE_URL` _(`drizzle-kit push` via `pnpm db:push`; full migration runner deferred)_
- [x] Migration: orgs, users, org_members, sso_identities, sessions
- [x] Auth: email/password (argon2), session cookies _(httpOnly + sameSite=lax; explicit CSRF token middleware not added)_
- [x] SSO: Google + GitHub OIDC; account linking _(Apple deferred per spec)_
- [x] Org auto-created on signup; `/api/auth/me` returns memberships

### Phase 2 — Apps & Git connections
- [x] CRUD: apps (8-char hex id generator)
- [ ] App settings (rename, icon upload, delete with confirm, transfer ownership by org id) _(rename + soft-delete via PATCH/DELETE on the API; UI page + transfer flow not built)_
- [x] OAuth apps registered for GitHub, GitLab, Bitbucket; connect/disconnect flows _(self-serve via `/admin/oauth-apps`)_
- [x] List repos endpoint per provider _(no TTL cache yet; safe because tokens are per-org)_
- [ ] Webhooks (optional v1.5): receive push events to refresh commit list

### Phase 3 — Web UI screens
- [x] Login + password reveal interaction + SSO buttons
- [x] Shell with 64+230 sidebars, org/app context, theme toggle
- [x] Apps list + "New App" dropdown + Import App wizard
- [x] App scope routes (Commits, Builds tree, Deploy tree, Settings)
- [ ] App-level Settings page (icon upload, rename, delete, transfer ownership)

### Phase 4 — Build pipeline backend
- [x] Clean ports of `uploadAndBuildAndroid.sh`, `uploadAndBuildiOS.sh`, plus a Linux Web runner — parameterized, structured step events, cleanup _(implemented as `apps/api/src/worker/runners/{linuxDocker,linuxWeb,macRunner}.ts` behind a `Runner` interface; promoted to a separate package once we run more than one worker process)_
- [x] Replace `sshpass` with SSH key auth on Mac host; rotate creds _(MacRunner is key-only)_
- [x] Replace zip-upload with `git clone --depth 1` on build host using stored OAuth token _(works for github/gitlab/bitbucket via `apps/api/src/worker/gitClone.ts`)_
- [x] Build hosts table; admin UI to register/test hosts; runners pick first online row, env-var fallback _(load-aware scheduling deferred — currently first-online)_
- [ ] pg-boss queue; dedicated `worker/` process _(using direct DB polling with `FOR UPDATE SKIP LOCKED` in-process; functionally equivalent for v1, switch to pg-boss when we split workers out)_
- [x] Per-build sandbox dir + secret materialization + always-cleanup
- [x] Log streaming: append to `builds.log_text`, fan out to WebSocket subscribers via `buildBus`
- [x] Artifact upload to xbuilds file server _(public URLs from `host.downloadsBaseUrl`; signed/HMAC URLs deferred)_

### Phase 5 — Build UI
- [x] Commits list (paginated) for connected repo _(github/gitlab/bitbucket)_
- [x] Create build form (target / stack / build type / environment) with conditional fields
- [x] Live build view: step pipeline, log stream (WebSocket with polling fallback), cancel button
- [x] Artifacts panel with platform-aware downloads (AAB/APK; IPA/dSYM/xcarchive)
- [x] Build history list _(no filters yet — add status/target filters when needed)_

### Phase 6 — Environments & Certificates
- [x] Environments CRUD + key/value editor with secret toggle
- [x] Certificates: iOS upload (p12 + password + provisioning) and Android (keystore + alias + key/store passwords)
- [x] Encrypt at rest (AES-256-GCM); decrypt only into build sandbox; secrets never returned to UI
- [x] Wire selected env + cert into build run _(LinuxDockerAndroidRunner materializes Android keystore; MacRunner materializes p12 + provisioning; env vars from selected environment passed as `-e` flags / shell exports)_

### Phase 7 — Deploy
- [x] Store Destinations CRUD: App Store / TestFlight (App Store Connect API key), Play Store (service account JSON, track)
- [x] Deployments: pick a successful build + destination, enqueue deploy
- [x] Worker handlers behind a `DeployRunner` interface — `AppStoreUploadRunner` (SSH to Mac → `xcrun altool` with materialized .p8) and `GooglePlayUploadRunner` (service-account JWT → edits API → upload AAB/APK → assign to track → commit). `StubDeployRunner` fallback when host unconfigured.
- [x] Deployment history + logs

### Phase 8 — Hardening
- [ ] Audit log for all sensitive ops _(table reserved in §3 data model; no writes yet)_
- [ ] Rate limiting, CSP, HSTS _(secure cookies on in prod via `env.isProd`)_
- [ ] Backup strategy for Postgres + artifacts
- [ ] Per-org quotas (build minutes, storage) _(plan limits enforce apps/seats/concurrent builds today)_
- [x] Configurable build host pool admin UI _(superadmin → Build hosts; runners prefer DB rows over env)_
- [ ] Observability: structured logs, metrics, error tracking (Sentry)

### Phase 9 — Polish
- [ ] Empty states, loading skeletons, error boundaries
- [ ] Keyboard shortcuts, accessibility pass
- [ ] Tauri auto-update channel
- [ ] Public docs site

---

## 6. Resolved decisions

1. **iOS build host (v1)**: NoMachine/HostMyApple. Worker treats it as a single host record so we can add more hosts later without code changes.
2. **Source delivery**: `git clone --depth 1 --branch <ref>` on the build host using the org's stored OAuth token. No more zip-and-upload.
3. **Auth providers (v1)**: email/password + Google + GitHub. Apple/Microsoft/SAML deferred.
4. **Multi-user orgs**: yes. `org_members` with roles owner/admin/member from day one. Seats enforced by plan.
5. **Plans** (see §7).
6. **Artifact retention**: no automatic expiration in v1. Storage is bounded by plan apps/seats. Revisit after we see real usage.
7. **Hosting**: existing Docker Swarm at `89.117.17.43`. Domain: `mobileflow.raidpr.com`. API at `api.mobileflow.raidpr.com` (or `/api` behind the same vhost — pick one in Phase 0).
8. **Reference `.env` credentials**: not committed; alpha only. Skip rotation for now.

---

## 7. Subscription plans (Stripe)

| Plan       | Price      | Apps | Seats | Concurrent builds | Builds enabled |
|------------|------------|------|-------|-------------------|----------------|
| Naboria    | Free       | 0    | 1     | 0                 | No (read-only / demo) |
| Bohío      | $9.99/mo   | 1    | 1     | 1                 | Yes |
| Yucayeque  | $14.99/mo  | 2    | 1     | 2                 | Yes |
| Cacique    | $24.99/mo  | 6    | 6     | 3                 | Yes |
| Unlimited  | internal   | ∞    | ∞     | ∞                 | Yes (internal / superadmin only) |

**Naboria** is "look but don't touch": users can sign up, see the UI, browse demo content, but cannot create apps or run builds. This protects the Mac/Docker compute from free-tier abuse.

**Enforcement points**
- App create: reject if `apps_count >= plan.max_apps`.
- Member invite/accept: reject if `seats_count >= plan.max_seats`.
- Build enqueue: reject if `plan.can_build = false`. While running, reject if `running_builds_for_org >= plan.max_concurrent_builds` (queue-with-limit, not hard reject — show "Waiting for slot").
- All checks are server-side in the API; UI also disables CTAs with explanatory tooltips.

---

## 8. Phased TODO (additions)

### Phase 3.6 — Superadmin (Master) console

A separate top-level area only visible to users with `is_superadmin = true`. Lives at `/admin` (outside the org/app routing tree). Used by us to operate the platform.

**Primary use case (for now): testing.** Superadmin + the `unlimited` plan let us drive every flow end-to-end (multi-app, multi-seat, concurrent builds, deploys) without hitting paywall caps or burning real Stripe charges. Production support/ops use is a secondary benefit.

- [x] `users.is_superadmin` column + migration; bootstrap on signup if email matches `SUPERADMIN_EMAIL`
- [x] Server-side guard middleware (`requireSuperadmin`); rejects with 404 to hide the surface
- [ ] CLI: `pnpm admin:promote <email>` / `admin:demote <email>` _(can be done via SQL or webhook for now)_
- [x] Sidebar entry "Admin" only rendered when `me.user.isSuperadmin === true`
- [x] Admin → Organizations: list, drill-in (members, apps, recent builds, plan), change plan (incl. `unlimited`), delete _(search/sort + lifetime counts not yet)_
- [x] Admin → Users: list with memberships, toggle superadmin, force-logout, delete _(reset-password email link not yet)_
- [x] Admin → Builds: cross-org feed with status pills, links into the live build view _(filters/force-cancel deferred — cancel works from within the build view)_
- [x] Admin → Hosts: register/edit build hosts, online/offline toggle, SSH test endpoint
- [x] Admin → OAuth Apps: register provider client_id/secret per (provider, kind) _(enables self-serve GitHub/GitLab/Bitbucket import)_
- [x] Admin → Plans: view/edit limits/prices; `unlimited` is read-only
- [ ] Admin → Audit log: cross-org event stream
- [ ] Audit logging: superadmin mutations recorded with `actor_user_id`, target, before/after diff
- [x] Plan-gate bypass for `unlimited` _(null limits short-circuit `assertCanCreateApp` / `assertCanStartBuild`)_

**Seeding the unlimited plan**
- [x] Seeder inserts `plans` row: `id='unlimited'`, all limits null, `can_build=true`, `is_internal=true`
- [x] Subscriptions UI hides any plan where `is_internal=true`
- [x] Stripe webhook handlers ignore subscriptions on internal plans

### Phase 3.5 — Org Settings (Account / Subscriptions / Usage)
- [x] Routes under outer-rail Settings: Account, Subscriptions, Usage
- [ ] Account: edit name, change password, linked providers (connect/disconnect Google, GitHub), delete account flow _(read-only profile + memberships only today)_
- [x] Subscriptions: plan grid, current plan card, Stripe Checkout for upgrade, Customer Portal _(downgrade end-of-period messaging not yet)_
- [x] Usage: derived counters with progress bars vs. plan limits

### Phase 4.5 — Billing backend
- [x] Stripe products + prices for Bohío / Yucayeque / Cacique (monthly) wired via env (`STRIPE_PRICE_*`); plans table seeded with limits
- [x] `subscriptions` table; default new orgs to Naboria
- [x] Stripe Checkout session + return URL handler
- [x] Stripe webhook handler: `checkout.session.completed`, `customer.subscription.created/updated`, `customer.subscription.deleted` _(`invoice.payment_failed` deferred)_
- [x] Plan-gating middleware applied to: app create, build enqueue _(member invite flow not yet built)_
- [ ] Cron: nightly usage rollups into `usage_counters` _(`usage_counters` table not yet created — live counters used today)_

### Phase 7.5 — Deployment to mobileflow.raidpr.com (matches existing RaidX swarm pattern)

Modeling after `References/RaidXAppBuilder/Source/.docker`:
- External Traefik already running on the cloud host, joined to network `traefik-public` (external) with cert resolver named `le`.
- Local Docker registry on the cloud host at `localhost:5005`. Images tagged `localhost:5005/<name>:<tag>`.
- Pipeline pattern: `start_pipeline.sh dev|prod` → `build.<env>.sh` → `deploy.<env>.sh`, run on the server inside the project dir.
- `.env` next to compose file holds `STACK_NAME`, `DOMAIN_NAME`, `APP_ROUTER`, `DOCKER_IMAGE_NAME`, `DOCKER_COMPOSE_PROD`, etc.
- Per-stack overlay network alongside `traefik-public` (e.g. `mobileflow-network`).

**Repo layout (mirrors RaidX)**
```
infra/
  .docker/
    Dockerfile.web              # nginx serving SPA bundle
    Dockerfile.api              # Node Fastify
    Dockerfile.worker           # Node worker (has docker CLI + ssh client)
    mobileflow.production.yml
    mobileflow.development.yml
    nginx.conf
    builder-entrypoint.sh
    .tools/
      build.prod.sh
      deploy.prod.sh
      build.dev.sh
      deploy.dev.sh
      detect.prod.sh
    start_pipeline.sh
  .env.example                  # STACK_NAME, DOMAIN_NAME, image tags, db creds, etc.
```

**Services in `mobileflow.production.yml`**
- `mobileflow_web` — nginx + SPA bundle, Traefik labels for `Host(\`mobileflow.raidpr.com\`)`, http→https redirect, `tls.certresolver=le`, port 80.
- `mobileflow_api` — Fastify; Traefik labels for same host with `PathPrefix(\`/api\`)` and a higher priority than web; WebSocket upgrade enabled (Traefik handles WS on the same router automatically).
- `mobileflow_worker` — no Traefik; mounts `/var/run/docker.sock` (so it can drive the Android docker builder on the same host), ssh keys for the Mac VM, bind mount for artifacts dir.
- `mobileflow_db` — `postgres:16` with named volume `mobileflow_db_data` (replacing the mariadb pattern).
- `mobileflow_pgadmin` — optional, Traefik with `PathPrefix(\`/pgadmin\`)` (mirrors the phpmyadmin block).

**Tasks**
- [ ] Author `Dockerfile.web` (multi-stage: pnpm build SPA → copy to `nginx:alpine`; nginx config does SPA fallback + sets WS-friendly headers under `/api`)
- [ ] Author `Dockerfile.api` (node:20-alpine, prod deps only, runs migrations on boot via entrypoint)
- [ ] Author `Dockerfile.worker` (node:20 + `docker-cli` + `openssh-client` + `git`)
- [ ] Write `mobileflow.production.yml` with services above, Traefik labels matching the RaidX style (`-http` and `-https` routers, `https-redirect` middleware, `traefik.constraint-label=traefik-public`)
- [ ] Create `mobileflow-network` (overlay, attachable) — `traefik-public` stays external
- [ ] Postgres named volume + entrypoint that runs Drizzle migrations on first boot
- [ ] Nightly `pg_dump` to `/root/RaidX/backups/mobileflow/` (cron on host or sidecar)
- [ ] Port `start_pipeline.sh` and `.tools/build.prod.sh` / `deploy.prod.sh` (push image to `localhost:5005`, then `docker stack deploy -c <compose> <STACK_NAME>`)
- [ ] Local dev: `pnpm dev` runs RSPack + api + worker on the workstation; `infra/.docker/mobileflow.development.yml` only spins up Postgres for parity
- [ ] Release script from a developer workstation: rsync source to `${CLOUD_USER}@${CLOUD_HOST}:${CLOUD_PATH}/mobileflow/`, then SSH to run `bash .docker/start_pipeline.sh prod`
- [ ] Confirm DNS for `mobileflow.raidpr.com` points to `89.117.17.43` before first deploy

**Key differences from RaidX template**
- We add a `worker` service (not in RaidX) — it runs the build orchestrator and needs the docker socket + ssh keys mounted.
- API serves a WebSocket endpoint for live build logs; ensure Traefik labels don't interfere (default works, but verify `Connection: Upgrade` passes through).
- Postgres replaces MariaDB; volume name and entrypoint adjusted accordingly.
- API route prefix is `/api` on the same host as the SPA — uses Traefik `PathPrefix` priority just like the `phpmyadmin` block does.
