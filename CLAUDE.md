# WSL

This project's pnpm scripts are run from WSL, not Windows.

- **Distro:** Ubuntu-22.04 (the only installed distro, default)
- **Node:** v22.4.0 managed by **fnm** (not nvm), installed under `~/.local/share/fnm/`
- **Invocation from Windows:** `wsl.exe -d Ubuntu-22.04 -e bash -ic '<command>'`
  - The `-i` (interactive) flag is required so `~/.bashrc` sources fnm. Without it, a login shell falls back to the system node (v12.22.9) and fnm-managed tools are missing from PATH.
- **pnpm:** the `pnpm` binary on PATH is a **corepack shim** that reads `packageManager` in `package.json` (currently `pnpm@8.15.6`). The corepack bundled with node 22.4.0 has **stale signing keys** and fails with `Cannot find matching keyid` — update it with `npm install -g corepack@latest` before first use.
  - Plain `wsl bash ...` from Git Bash on Windows hits Git Bash, **not** WSL. Always use `wsl.exe` explicitly.

# Production deploy (Caimón)

Production is the Docker Swarm stack **`caimon`** at **https://caimon.raidpr.com**
(swarm host `89.117.17.43`, behind Traefik, replacing the old `crossx` stack).

- `./start.sh prod` — the whole pipeline: zip the workspace → scp → build the
  web + API images on the host → pg_dump → rolling `docker stack deploy`.
- **Admin → Deploy → “Caimón — live”** runs that same script from the API and
  streams the log into the page. Superadmin only, and disabled when the API
  itself runs in production.
- Secrets live in `.env.production` at the workspace root (gitignored; template
  at `.docker/.env.production.example`). The deploy aborts if it's missing.
- Everything else — topology, schema handling, backups, rollback, retiring
  crossx — is in [`.docker/DEPLOY.md`](.docker/DEPLOY.md).
