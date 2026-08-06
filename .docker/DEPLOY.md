# Caimón — production deployment

MobileFlow ships to production as the Docker Swarm stack **`caimon`** at
**https://caimon.raidpr.com**, on the same swarm host that ran the old `crossx`
stack (RaidXAppBuilder). Traefik fronts it, and images come from the host's
local registry on `localhost:5005`.

## Topology

| Service | Image                              | Route (Traefik)        | Port |
|---------|-----------------------------------|------------------------|------|
| web     | `localhost:5005/caimon_web:<tag>` | `caimon.raidpr.com`    | 80 (nginx) |
| api     | `localhost:5005/caimon_api:<tag>` | internal only          | 4000 (Fastify) |
| db      | `postgres:16-alpine`              | internal only          | 5432 |

One public hostname, not two. The SPA calls the API same-origin — nginx proxies
`/api/*` (including the WebSocket upgrade the build and deploy log streams need)
to `api:4000` — so session cookies, CSRF and `wss://` all work without any
cross-origin configuration, and the API is never exposed directly.

That also fixes the OAuth/webhook URLs at `https://caimon.raidpr.com/api/...`:

- OAuth redirect URIs: `https://caimon.raidpr.com/api/auth/oauth/<provider>/callback`
  (and `.../api/auth/git/<provider>/callback` for git connections)
- Stripe webhook: `https://caimon.raidpr.com/api/billing/webhook`

## Deploy

Two ways to run the exact same pipeline:

```bash
# 1. Terminal, from the workspace root
cp .docker/.env.production.example .env.production   # fill in secrets (gitignored)
./start.sh prod
```

2. **Admin → Deploy → “Caimón — live” → Deploy to live.** The API spawns
   `bash start.sh prod` and streams stdout/stderr into the page over a
   WebSocket. Superadmin only, and refused entirely when the API itself runs
   with `NODE_ENV=production` (a production API has no business shelling out to
   deploy scripts) — so this button exists on a developer's machine, which is
   also where the SSH key lives.

What runs, in order:

`start.sh` → `.docker/.tools/start.prod.sh` (local: zip the workspace, ssh, upload,
extract) → `.docker/start_pipeline.sh prod` (on the host) →
`build.prod.sh` (builds both images, each tagged `BUILD_TAG=YYYYMMDD_HHMMSS`) →
`backup.prod.sh` (pg_dump of the live DB) →
`deploy.prod.sh` (`docker stack deploy -c caimon.production.yml caimon`) →
`detect.prod.sh` (polls the public URL, bounded) →
`clean.prod.sh` (drops the extracted sources, prunes old image tags).

The zip ships your **working copy**, not a git ref — uncommitted changes deploy.

## Safe redeploys — what happens to Postgres

Redeploys never tear the stack down (`docker stack rm` is deliberately absent,
unlike the old crossx pipeline). `docker stack deploy` performs a rolling update:

- Each build is tagged uniquely, so Swarm sees a new image reference for
  `api`/`web` and rolls them one at a time with `order: start-first` — the new
  task must pass its healthcheck before the old one stops (zero downtime). Web
  health is nginx answering on `:80`; API health is `GET /health`, which only
  answers after the schema push and seed have succeeded.
- The `db` service spec is **identical** on every deploy, so Swarm leaves the
  running Postgres task untouched — it is never recreated. Data lives in the
  named volume `caimon_db`, which survives even a manual `docker stack rm`
  (only `docker volume rm` destroys it).
- If a new `api` task never goes healthy (a bad schema change, a missing env
  var), the update **auto-rolls-back** to the previous image, and the pre-deploy
  pg_dump is the data safety net.

## Schema changes

The API has no migration files — it uses `drizzle-kit push`, and the container
runs `db:push:prod` on boot (`drizzle.config.prod.ts`, `strict: false`) between
`wait-for-db` and `db:seed`.

Additive changes (new table, new nullable column) apply unattended. A change
that would **drop data** makes drizzle-kit prompt; with no TTY in the container
that fails, the task never goes healthy, and Swarm rolls back. That is
intentional: destructive schema changes are applied by hand, deliberately,
against a database that `backup.prod.sh` has just dumped.

```bash
# on the cloud host, against the running stack
CID=$(docker ps --filter "label=com.docker.swarm.service.name=caimon_db" -q | head -n1)
docker exec -it "$CID" psql -U caimon -d caimon
```

## Backups & restore

`backup.prod.sh` runs **before** the new stack is applied. It `pg_dump`s the
running DB to `/root/dev/caimon-backups` on the host, gzipped, keeping the
newest 10 and **aborting the deploy if the dump fails** — we never change the
schema without a backup. On the first-ever deploy (no DB yet) it skips cleanly.

Restore a dump on the cloud host:

```bash
DUMP=/root/dev/caimon-backups/caimon_YYYYMMDD_HHMMSS.sql.gz
CID=$(docker ps --filter "label=com.docker.swarm.service.name=caimon_db" -q | head -n1)
# taken with --clean --if-exists, so it drops and recreates objects
gunzip -c "$DUMP" | docker exec -i "$CID" psql -U caimon -d caimon
```

## Rollback (app only)

Roll back without a rebuild — `clean.prod.sh` keeps the newest 3 image tags per
repo, so the previous build is always there:

```bash
docker service rollback caimon_api
docker service rollback caimon_web
```

## Secrets

`.env.production` at the workspace root (gitignored; template at
`.docker/.env.production.example`) holds everything the stack file substitutes:
DB password, cookie secret, token encryption key, bootstrap accounts, OAuth
credentials, build-host config. `start.prod.sh` ships it with the build and
`start_pipeline.sh` sources it on the host; the deploy aborts early if it is
missing. `clean.prod.sh` leaves it on the host at `chmod 600` so an operator can
re-apply or roll back the stack without a full redeploy.

Build-host **private keys are never baked into an image**. Put them in
`$CAIMON_KEYS_DIR` on the host (default `/root/dev/caimon-keys`, `chmod 600`);
it is bind-mounted read-only at `/keys` in the api container, and the
`*_SSH_KEY_PATH` vars point at `/keys/<file>`.

`TRUST_PROXY` deserves a note: requests arrive as Traefik → web(nginx) → api,
so the peer the API sees is the nginx container on the `caimon-network` overlay,
not loopback. `CAIMON_TRUST_PROXY` names that subnet. `true` is rejected at boot
— it would let a client forge its own IP through `X-Forwarded-For` and poison
rate-limit keys and audit logs.

## Prerequisites on the host

- DNS: `caimon.raidpr.com` → the swarm host (`89.117.17.43`). Traefik's
  Let's Encrypt resolver (`le`) issues the certificate on first request.
- The `traefik-public` overlay network exists (it already does — crossx used it).
- The local registry on `:5005`; `start_pipeline.sh` starts it if it isn't up.
- `api` and `db` are pinned to a manager node so the local volumes and the
  `/keys` bind stay with their tasks. For a multi-node swarm, push the tagged
  images and add `--with-registry-auth` to `docker stack deploy`.

## Retiring the old crossx stack

Caimón replaces `crossx` (crossx.raidpr.com, the RaidXAppBuilder PHP app). The
two are independent — different stack, network, volumes, hostname — so Caimón
can be deployed and verified while crossx is still running.

Removing crossx is deliberately **not** part of the pipeline. When you're ready,
on the cloud host:

```bash
bash /root/dev/raidpr.com/apps/caimon/.docker/.tools/teardown.crossx.sh           # dry run: show what exists
bash /root/dev/raidpr.com/apps/caimon/.docker/.tools/teardown.crossx.sh --yes     # final mysqldump, then remove the stack
bash /root/dev/raidpr.com/apps/caimon/.docker/.tools/teardown.crossx.sh --yes --volumes  # also drop raid_db_data (irreversible)
```

It dumps the builder's MariaDB to `/root/dev/crossx-final-backup` before
removing anything, and tells you where the old build directory
(`/root/dev/raidpr.com/apps/crossx`) still sits so you can delete it yourself.
