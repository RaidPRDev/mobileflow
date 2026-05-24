# Re-importing admin tables after `dev:nuke`

`pnpm dev:nuke` drops the Postgres volume, so every admin-configured row is
wiped. Two scripts make `payment_processors` and `oauth_apps` survive the
cycle without re-entering them in the UI:

- `pnpm db:export-admin` — dumps both tables to `infra/seed/admin-seed.sql`
- `pnpm db:import-admin` — replays that SQL file back into the fresh DB

`infra/seed/` is gitignored — the file lives only on your machine.

## One-time setup

Configure payment processors and OAuth apps in the admin UI as usual, **then**
snapshot them:

```bash
pnpm db:export-admin
```

This writes `infra/seed/admin-seed.sql` containing `INSERT … ON CONFLICT DO
NOTHING` statements for both tables. Re-run this any time you change creds in
the admin UI (or after rotating `APP_ENCRYPTION_KEY` — see caveat below).

## Nuke → restore cycle

```bash
# 1. wipe the DB volume + Postgres image
pnpm dev:nuke

# 2. bring everything back up (starts container, runs migrations, seeds, boots API)
pnpm dev:up
```

In a **separate terminal** (so it doesn't kill the API server started by
`dev:up`), restore admin rows:

```bash
pnpm db:import-admin
```

You should see row counts printed for both tables. Done — payment processors
and OAuth apps are back without touching the admin UI.

## What the import script checks

Before replaying the SQL it verifies:

1. The `mobileflow_dev_db` container is running. If not, it tells you to run
   `pnpm dev:up` first.
2. `public.payment_processors` and `public.oauth_apps` exist (i.e. drizzle
   migrations have run). `pnpm dev:up` handles this automatically; if you
   bring the DB up manually with `pnpm dev:db`, run `pnpm db:push` before
   importing.
3. `infra/seed/admin-seed.sql` exists. If not, generate it with
   `pnpm db:export-admin` from a DB that still has the rows.

## Caveat — encryption key must match

Secret columns are AES-256-GCM ciphertext:

- `payment_processors.credentials_enc`, `config_enc`
- `oauth_apps.client_secret_enc`

They only decrypt if the same `APP_ENCRYPTION_KEY` (whatever env var the API
uses) is in place when the rows are read. If you rotate the key, the seed
file is dead weight — regenerate it with `pnpm db:export-admin` from a DB
state that still has the *new* key encoded into the ciphertext.

## Files involved

| File | Purpose |
| --- | --- |
| `infra/scripts/db-export-admin.mjs` | Runs `pg_dump` inside the container, rewrites inserts to be idempotent, writes the seed file. |
| `infra/scripts/db-import-admin.mjs` | Verifies container + schema + seed file, pipes the SQL through `psql`, prints row counts. |
| `infra/seed/admin-seed.sql` | Generated. Gitignored. Contains `INSERT … ON CONFLICT DO NOTHING` for both tables. |
