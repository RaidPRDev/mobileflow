---
name: MobileFlow API runs in WSL, web in Windows
description: The MobileFlow API server runs inside WSL (Linux), surfaced to Windows via wslrelay on ports 4000/5173. File paths in apps/api/.env must use WSL paths (/mnt/d/...), not Windows paths.
type: project
originSessionId: 5fe582f1-8e2d-4a8d-8eb2-9aa620d1d5d0
---
The MobileFlow API server (apps/api) runs inside WSL on this machine, not natively on Windows. Windows sees the ports via `wslrelay.exe` forwarding 4000 (API) and 5173 (web/Vite). The web dev server may run in either, but the API is the one that matters for paths.

**Why:** Discovered while debugging an iOS build that failed with `ENOENT: ... open 'D:\dev\raidpr\apps\_keys\raidpr_mac_key'` — the path was a valid Windows path but invalid inside WSL where Node was actually running. Confirmed by finding wslrelay owning the API/web ports.

**How to apply:**
- Any filesystem path in `apps/api/.env` (e.g. `MAC_BUILD_SSH_KEY_PATH`, `LINUX_BUILD_SSH_KEY_PATH`, anything else that lands in `readFileSync`) must use WSL paths like `/mnt/d/dev/raidpr/apps/_keys/...`, not `D:\...`.
- When debugging "file not found" errors with Windows-shaped paths, suspect the WSL/Windows boundary first.
- `.env` is loaded once at API startup, so the API must be restarted after editing it.
- Note: ssh2 npm lib doesn't enforce strict private-key file permissions like OpenSSH; a 0444 key still loads.
