# WSL

This project's pnpm scripts are run from WSL, not Windows.

- **Distro:** Ubuntu-22.04 (the only installed distro, default)
- **Node:** v22.4.0 managed by **fnm** (not nvm), installed under `~/.local/share/fnm/`
- **Invocation from Windows:** `wsl.exe -d Ubuntu-22.04 -e bash -ic '<command>'`
  - The `-i` (interactive) flag is required so `~/.bashrc` sources fnm. Without it, a login shell falls back to the system node (v12.22.9) and fnm-managed tools are missing from PATH.
- **pnpm:** the `pnpm` binary on PATH is a **corepack shim** that reads `packageManager` in `package.json` (currently `pnpm@8.15.6`). The corepack bundled with node 22.4.0 has **stale signing keys** and fails with `Cannot find matching keyid` — update it with `npm install -g corepack@latest` before first use.
  - Plain `wsl bash ...` from Git Bash on Windows hits Git Bash, **not** WSL. Always use `wsl.exe` explicitly.
