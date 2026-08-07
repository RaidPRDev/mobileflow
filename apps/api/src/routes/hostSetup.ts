import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
// ssh2 is CommonJS; `utils` isn't detected as a named ESM export by Node's
// CJS lexer, so it must come off the default export.
import ssh2, { Client as SshClient } from "ssh2";
const sshUtils = ssh2.utils;
import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireSuperadmin } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { buildHosts } from "../db/schema.js";
import { decryptString } from "../lib/crypto.js";
import { writeAdminLog } from "../lib/adminLogs.js";
import { env } from "../env.js";
import { withSsh, type SshTarget } from "../worker/ssh.js";

/**
 * Mac build-host provisioning: Admin → Build hosts → Edit → "Server setup".
 *
 * Turns a fresh Mac (Remote Login enabled + Xcode installed — the only two
 * things that can't be done over SSH) into a working public build host:
 * Homebrew, build tooling, a WireGuard tunnel with autostart, keep-awake.
 *
 * Design mirrors routes/localDeploy.ts:
 *  1. **Scripts are constants.** Each step's bash body is declared below; the
 *     only interpolated values come from the API's own VPN_* env config
 *     (validated against a conservative charset), never from the request.
 *  2. **Superadmin + local-development only** (same ADMIN_LOCAL_DEPLOY escape
 *     hatch). Provisioning SSHes around your home network — a production API
 *     has no business doing that.
 *  3. **Jobs live in memory** and are polled, not persisted.
 *
 * The sudo password travels request body → job memory → remote stdin
 * (`sudo -S`). It is never placed in argv, env, logs, or the database, and is
 * discarded when the job ends.
 *
 * Every mutating step appends to `~/.mobileflow/provision.log` on the Mac and
 * records revert data in `~/.mobileflow/provision.state` (installed formulae,
 * previous pmset values, the WireGuard public key), so the UI can show what
 * setup did and undo it step by step.
 */

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------

export type StepStatus = "ok" | "missing" | "unknown" | "error";

interface StepDef {
  id: string;
  title: string;
  description: string;
  /** "auto" steps have a Run action; "manual" steps only show instructions. */
  kind: "auto" | "manual";
  runNeedsSudo?: boolean;
  revertNeedsSudo?: boolean;
  /** Step can only run when the API has VPN_* env config. */
  needsVpn?: boolean;
  run?: string;
  revert?: string;
}

/** Values interpolated into scripts come only from env config; keep them tame. */
const SAFE_CFG = /^[\w.\-:/=+]*$/;
function cfg(value: string | undefined, name: string): string {
  const v = value ?? "";
  if (!SAFE_CFG.test(v)) throw new Error(`${name} contains characters not allowed in setup scripts`);
  return v;
}

const vpnConfigured = () =>
  !!(env.VPN_SERVER_ENDPOINT && env.VPN_SERVER_PUBLIC_KEY && env.VPN_MAC_IP);

// routes/ → src/ → apps/api/ → apps/ → repo root (same as localDeploy.ts).
const repoRoot = resolvePath(fileURLToPath(new URL(".", import.meta.url)), "../../../..");

/**
 * SSH target for the production swarm host (caimon), read from the deploy
 * tooling's own config (.docker/.config.env.tools) so the UI needs no extra
 * setup. The SSH key path in that file is Windows-style; convert for WSL.
 */
function prodTarget(): SshTarget | null {
  try {
    const text = readFileSync(resolvePath(repoRoot, ".docker/.config.env.tools"), "utf8");
    const get = (k: string) => {
      const m = text.match(new RegExp(`^${k}="?([^"\\r\\n]*)"?\\s*$`, "m"));
      return m?.[1]?.trim();
    };
    const host = get("CLOUD_HOST");
    let keyPath = get("SSH_KEY");
    if (!host || !keyPath) return null;
    keyPath = keyPath.replace(/\\/g, "/");
    if (process.platform !== "win32") {
      keyPath = keyPath.replace(/^([A-Za-z]):\//, (_m, d: string) => `/mnt/${d.toLowerCase()}/`);
    }
    return {
      host,
      port: 22,
      username: get("CLOUD_USER") || "root",
      privateKey: Buffer.from(readFileSync(keyPath, "utf8"), "utf8"),
    };
  } catch {
    return null;
  }
}

/** Where the VPS key lives: env-configured path, or a default the UI upload can fill. */
function vpsKeyPath(): string {
  return env.VPN_VPS_SSH_KEY_PATH ?? resolvePath(process.cwd(), ".data/vpn-vps-key");
}

function vpsTarget(): SshTarget | null {
  if (!env.VPN_VPS_HOST) return null;
  try {
    return {
      host: env.VPN_VPS_HOST,
      port: env.VPN_VPS_PORT,
      username: env.VPN_VPS_USER,
      privateKey: Buffer.from(readFileSync(vpsKeyPath(), "utf8"), "utf8"),
    };
  } catch {
    return null;
  }
}

/**
 * Can the API reach the WireGuard server with its stored key? Drives the
 * "VPN server access" panel: `no-key` shows the upload dropzone, `denied`
 * additionally offers the one-time password bootstrap.
 */
async function vpsAccess(): Promise<"unconfigured" | "no-key" | "ok" | "denied" | "unreachable"> {
  if (!env.VPN_VPS_HOST) return "unconfigured";
  const target = vpsTarget();
  if (!target) return "no-key";
  try {
    await withSsh(target, (ssh) => execScript(ssh, "echo ok", null, () => {}));
    return "ok";
  } catch (err) {
    return /denied|authentication|auth/i.test((err as Error).message) ? "denied" : "unreachable";
  }
}

/** OpenSSH authorized_keys line for the stored VPS private key. */
function vpsPublicKeyLine(): string | null {
  try {
    const parsed = sshUtils.parseKey(readFileSync(vpsKeyPath(), "utf8"));
    if (parsed instanceof Error) return null;
    return `${parsed.type} ${parsed.getPublicSSH().toString("base64")} mobileflow-vpn-admin`;
  } catch {
    return null;
  }
}

/** One-shot exec over password-authenticated SSH (the key-install bootstrap). */
function execWithPassword(
  opts: { host: string; port: number; username: string; password: string },
  cmd: string,
): Promise<{ code: number; output: string }> {
  return new Promise((promiseResolve, promiseReject) => {
    const c = new SshClient();
    c.once("error", promiseReject);
    c.once("ready", () => {
      c.exec(cmd, (err, stream) => {
        if (err) {
          c.end();
          return promiseReject(err);
        }
        let out = "";
        stream
          .on("data", (b: Buffer) => { out += b.toString("utf8"); })
          .on("close", (code: number | null) => {
            c.end();
            promiseResolve({ code: code ?? -1, output: out });
          })
          .stderr.on("data", (b: Buffer) => { out += b.toString("utf8"); });
      });
    });
    c.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      readyTimeout: 15_000,
    });
  });
}

// Shared helpers prepended to every script. Manifest log + key=value state
// file live under ~/.mobileflow on the Mac so "what did setup do" survives
// API restarts and is inspectable by hand.
const PRELUDE = `
set -o pipefail
MF_DIR="$HOME/.mobileflow"
mkdir -p "$MF_DIR"
mflog() { printf '%s  %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$MF_DIR/provision.log"; }
set_state() {
  touch "$MF_DIR/provision.state"
  grep -v "^$1=" "$MF_DIR/provision.state" > "$MF_DIR/provision.state.tmp" 2>/dev/null || true
  printf '%s=%s\\n' "$1" "$2" >> "$MF_DIR/provision.state.tmp"
  mv "$MF_DIR/provision.state.tmp" "$MF_DIR/provision.state"
}
get_state() { grep "^$1=" "$MF_DIR/provision.state" 2>/dev/null | tail -1 | cut -d= -f2-; }
del_state() {
  [ -f "$MF_DIR/provision.state" ] || return 0
  grep -v "^$1=" "$MF_DIR/provision.state" > "$MF_DIR/provision.state.tmp" 2>/dev/null || true
  mv "$MF_DIR/provision.state.tmp" "$MF_DIR/provision.state"
}
find_brew() {
  for p in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$p" ]; then echo "$p"; return 0; fi
  done
  return 1
}
`;

// Prepended when a step needs root. The password is the FIRST line of stdin;
// `sudo -S -p ''` reads it silently, and the -v up front both verifies it and
// caches the timestamp for the rest of the session.
const SUDO_PRELUDE = `
IFS= read -r SUDO_PW
sudo_run() { printf '%s\\n' "$SUDO_PW" | sudo -S -p '' "$@"; }
if ! printf '%s\\n' "$SUDO_PW" | sudo -S -p '' -v 2>/dev/null; then
  echo '!! sudo authentication failed - check the password and try again'
  exit 90
fi
`;

function stepDefs(): StepDef[] {
  const gatewayIp = cfg(env.VPN_GATEWAY_IP, "VPN_GATEWAY_IP");
  const subnet = cfg(env.VPN_SUBNET, "VPN_SUBNET");
  const macIp = cfg(env.VPN_MAC_IP, "VPN_MAC_IP");
  const prodIp = cfg(env.VPN_PROD_IP, "VPN_PROD_IP");
  const endpoint = cfg(env.VPN_SERVER_ENDPOINT, "VPN_SERVER_ENDPOINT");
  const serverPub = cfg(env.VPN_SERVER_PUBLIC_KEY, "VPN_SERVER_PUBLIC_KEY");
  // "10.90.90.0/24" → "24"; wg Address wants the same mask as the subnet.
  const mask = subnet.includes("/") ? subnet.split("/")[1] : "24";

  return [
    {
      id: "connect",
      title: "SSH connection",
      description:
        "MobileFlow can reach the Mac over SSH with the stored key. On a fresh Mac: System Settings → General → Sharing → enable Remote Login, then add the public key to ~/.ssh/authorized_keys.",
      kind: "manual",
    },
    {
      id: "xcode",
      title: "Xcode toolchain",
      description:
        "Xcode must be installed by hand (App Store needs an Apple ID). After installing: open Xcode once, then run: sudo xcodebuild -license accept",
      kind: "manual",
    },
    {
      id: "homebrew",
      title: "Homebrew",
      description: "Package manager used to install the rest of the tooling.",
      kind: "auto",
      runNeedsSudo: true,
      run: `
if find_brew >/dev/null; then echo "Homebrew already installed at $(find_brew)"; exit 0; fi
echo "Installing Homebrew (non-interactive) - this can take a few minutes..."
( while true; do printf '%s\\n' "$SUDO_PW" | sudo -S -p '' -v 2>/dev/null || true; sleep 50; done ) &
KEEPALIVE=$!
trap 'kill $KEEPALIVE 2>/dev/null' EXIT
export NONINTERACTIVE=1
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
BREW="$(find_brew)" || { echo '!! installer finished but brew was not found'; exit 1; }
mflog "homebrew installed ($("$BREW" --version | head -1))"
echo "Homebrew installed: $BREW"
`,
    },
    {
      id: "buildtools",
      title: "Build tooling",
      description: "CocoaPods and xcbeautify via Homebrew (git ships with Xcode's CLT).",
      kind: "auto",
      run: `
BREW="$(find_brew)" || { echo '!! Homebrew is required first'; exit 1; }
eval "$("$BREW" shellenv)"
TO_INSTALL=""
command -v pod >/dev/null 2>&1 || TO_INSTALL="$TO_INSTALL cocoapods"
command -v xcbeautify >/dev/null 2>&1 || TO_INSTALL="$TO_INSTALL xcbeautify"
if [ -z "$TO_INSTALL" ]; then echo "Build tools already present."; exit 0; fi
echo "Installing:$TO_INSTALL"
"$BREW" install $TO_INSTALL
PREV="$(get_state buildtools_installed)"
set_state buildtools_installed "$PREV$TO_INSTALL"
mflog "buildtools installed:$TO_INSTALL"
echo "Done."
`,
      revert: `
BREW="$(find_brew)" || { echo "brew not found - nothing to revert"; exit 0; }
INSTALLED="$(get_state buildtools_installed)"
if [ -z "$INSTALLED" ]; then echo "Setup did not install these - not touching brew packages."; exit 0; fi
echo "Uninstalling:$INSTALLED"
"$BREW" uninstall $INSTALLED || true
del_state buildtools_installed
mflog "buildtools reverted:$INSTALLED"
echo "Done."
`,
    },
    {
      id: "wireguard",
      title: "WireGuard tools",
      description: "wireguard-tools (wg, wg-quick) via Homebrew — the tunnel client.",
      kind: "auto",
      run: `
BREW="$(find_brew)" || { echo '!! Homebrew is required first'; exit 1; }
if command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1; then
  echo "wireguard-tools already installed."; exit 0
fi
"$BREW" install wireguard-tools
set_state wireguard_installed "wireguard-tools"
mflog "wireguard-tools installed"
echo "Done."
`,
      revert: `
BREW="$(find_brew)" || { echo "brew not found - nothing to revert"; exit 0; }
if [ -z "$(get_state wireguard_installed)" ]; then echo "Setup did not install wireguard-tools - leaving it."; exit 0; fi
"$BREW" uninstall wireguard-tools || true
del_state wireguard_installed
mflog "wireguard-tools reverted"
echo "Done."
`,
    },
    {
      id: "vpnconf",
      title: "VPN tunnel config (wg0)",
      description:
        "Generates a key pair on the Mac and writes wg0.conf (split tunnel — only VPN-subnet traffic uses it). The peer must also be registered on the WireGuard server; that happens automatically when VPN_VPS_* is configured, otherwise the log prints the exact commands.",
      kind: "auto",
      needsVpn: true,
      revertNeedsSudo: true,
      run: `
BREW="$(find_brew)" || { echo '!! Homebrew is required first'; exit 1; }
eval "$("$BREW" shellenv)"
command -v wg >/dev/null 2>&1 || { echo '!! wireguard-tools is required first'; exit 1; }
WGDIR="$("$BREW" --prefix)/etc/wireguard"
mkdir -p "$WGDIR"
CONF="$WGDIR/wg0.conf"
if [ -e "$CONF" ]; then echo "wg0.conf already exists at $CONF - revert this step first to regenerate."; exit 0; fi
umask 077
PRIV="$(wg genkey)"
PUB="$(printf '%s' "$PRIV" | wg pubkey)"
cat > "$CONF" <<WGEOF
[Interface]
PrivateKey = $PRIV
Address = ${macIp}/${mask}

[Peer]
PublicKey = ${serverPub}
Endpoint = ${endpoint}
AllowedIPs = ${subnet}
PersistentKeepalive = 25
WGEOF
chmod 600 "$CONF"
set_state wg_public_key "$PUB"
mflog "vpnconf written $CONF (pubkey $PUB)"
echo "Wrote $CONF"
echo "Mac tunnel address: ${macIp}"
echo "::PUBKEY::$PUB"
`,
      revert: `
BREW="$(find_brew || true)"
PUB="$(get_state wg_public_key)"
if [ -n "$BREW" ]; then
  BREWBIN="$(dirname "$BREW")"
  # macOS system bash is 3.2; wg-quick needs 4+, so run it with brew's bash.
  if [ -x "$BREWBIN/bash" ] && [ -x "$BREWBIN/wg-quick" ]; then
    sudo_run env PATH="$BREWBIN:/usr/bin:/bin:/usr/sbin:/sbin" "$BREWBIN/bash" "$BREWBIN/wg-quick" down wg0 2>/dev/null || echo "(tunnel was not up)"
  fi
fi
CONF=""
[ -n "$BREW" ] && CONF="$("$BREW" --prefix)/etc/wireguard/wg0.conf"
if [ -n "$CONF" ] && [ -e "$CONF" ]; then rm -f "$CONF" && echo "Removed $CONF"; else echo "wg0.conf not present"; fi
del_state wg_public_key
mflog "vpnconf reverted"
if [ -n "$PUB" ]; then echo "::PUBKEY-REMOVE::$PUB"; fi
echo "Done."
`,
    },
    {
      // No bash body — the run route special-cases this id: it reads the Mac's
      // recorded public key, then SSHes to the WireGuard server to add/remove
      // the peer. Needs VPN_VPS_* so the API can reach that server.
      id: "vpnpeer",
      title: "Server peer registration",
      description:
        "Registers the Mac's public key as a peer on the WireGuard server (Revert removes it). Requires VPN_VPS_HOST/USER/SSH_KEY_PATH on the API; without them, run the wg set command from the tunnel-config log on the server by hand.",
      kind: "auto",
      needsVpn: true,
    },
    {
      id: "vpndaemon",
      title: "Tunnel autostart (launchd)",
      description:
        "System daemon that brings wg0 up at boot (/Library/LaunchDaemons/com.mobileflow.wg0.plist) — the tunnel survives reboots with nobody logged in.",
      kind: "auto",
      needsVpn: true,
      runNeedsSudo: true,
      revertNeedsSudo: true,
      run: `
BREW="$(find_brew)" || { echo '!! Homebrew is required first'; exit 1; }
BREWBIN="$(dirname "$BREW")"
WGQUICK="$BREWBIN/wg-quick"
[ -x "$WGQUICK" ] || { echo '!! wg-quick not found - install WireGuard tools first'; exit 1; }
# macOS system bash is 3.2; wg-quick needs 4+. Make sure brew's bash exists and
# run wg-quick through it explicitly (shebang env-resolution can't be trusted
# under launchd/sudo where PATH lacks the brew bin dir).
"$BREW" list bash >/dev/null 2>&1 || "$BREW" install bash
BASH5="$BREWBIN/bash"
[ -x "$BASH5" ] || { echo '!! Homebrew bash not found after install'; exit 1; }
CONF="$("$BREW" --prefix)/etc/wireguard/wg0.conf"
[ -e "$CONF" ] || { echo '!! wg0.conf not found - run the VPN tunnel config step first'; exit 1; }
PLIST=/Library/LaunchDaemons/com.mobileflow.wg0.plist
TMPPLIST="$(mktemp)"
cat > "$TMPPLIST" <<PLEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mobileflow.wg0</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BASH5</string>
    <string>$WGQUICK</string>
    <string>up</string>
    <string>wg0</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$BREWBIN:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/var/log/mobileflow-wg0.log</string>
  <key>StandardErrorPath</key><string>/var/log/mobileflow-wg0.log</string>
</dict>
</plist>
PLEOF
sudo_run cp "$TMPPLIST" "$PLIST"
rm -f "$TMPPLIST"
sudo_run chown root:wheel "$PLIST"
sudo_run chmod 644 "$PLIST"
sudo_run launchctl bootout system/com.mobileflow.wg0 2>/dev/null || true
sudo_run launchctl bootstrap system "$PLIST"
mflog "vpndaemon installed $PLIST"
echo "Autostart daemon installed and started."
`,
      revert: `
PLIST=/Library/LaunchDaemons/com.mobileflow.wg0.plist
sudo_run launchctl bootout system/com.mobileflow.wg0 2>/dev/null || echo "(daemon was not loaded)"
sudo_run rm -f "$PLIST"
mflog "vpndaemon removed"
echo "Autostart daemon removed."
`,
    },
    {
      id: "keepawake",
      title: "Keep Mac awake",
      description:
        "Disables system sleep so builds don't die when the lid-closed Mac idles. Display sleep is left alone. Previous values are recorded for revert.",
      kind: "auto",
      runNeedsSudo: true,
      revertNeedsSudo: true,
      run: `
PREV_SLEEP="$(pmset -g | awk '$1=="sleep"{print $2; exit}')"
PREV_DISK="$(pmset -g | awk '$1=="disksleep"{print $2; exit}')"
[ -n "$PREV_SLEEP" ] || PREV_SLEEP=1
[ -n "$PREV_DISK" ] || PREV_DISK=10
[ -n "$(get_state pmset_prev_sleep)" ] || set_state pmset_prev_sleep "$PREV_SLEEP"
[ -n "$(get_state pmset_prev_disksleep)" ] || set_state pmset_prev_disksleep "$PREV_DISK"
sudo_run pmset -a sleep 0 disksleep 0
mflog "keepawake enabled (was sleep=$PREV_SLEEP disksleep=$PREV_DISK)"
echo "System sleep disabled."
`,
      revert: `
PS="$(get_state pmset_prev_sleep)"
PD="$(get_state pmset_prev_disksleep)"
if [ -z "$PS" ]; then echo "No recorded previous values - leaving pmset as-is."; exit 0; fi
sudo_run pmset -a sleep "$PS" disksleep "$PD"
del_state pmset_prev_sleep
del_state pmset_prev_disksleep
mflog "keepawake reverted (sleep=$PS disksleep=$PD)"
echo "Restored sleep=$PS disksleep=$PD"
`,
    },
    {
      id: "firewall",
      title: "Firewall (stealth mode)",
      description:
        "macOS stealth mode silently drops unsolicited inbound connections — including SSH from the production host through the tunnel, which makes remote builds fail intermittently. This turns stealth mode off (the firewall itself stays on); revert restores it.",
      kind: "auto",
      runNeedsSudo: true,
      revertNeedsSudo: true,
      run: `
SFW=/usr/libexec/ApplicationFirewall/socketfilterfw
CUR="$("$SFW" --getstealthmode 2>/dev/null)"
case "$CUR" in
  *on*) WAS=on ;;
  *) WAS=off ;;
esac
if [ "$WAS" = "off" ]; then echo "Stealth mode is already off."; exit 0; fi
[ -n "$(get_state stealth_prev)" ] || set_state stealth_prev "$WAS"
sudo_run "$SFW" --setstealthmode off >/dev/null 2>&1 || true
sleep 1
CUR="$("$SFW" --getstealthmode 2>/dev/null)"
case "$CUR" in
  *off*) ;;
  *)
    # Recent macOS versions acknowledge --setstealthmode but don't apply it.
    # Write the preference directly and bounce the firewall so it reloads.
    echo "socketfilterfw did not apply the change - using defaults write + firewall reload"
    sudo_run defaults write /Library/Preferences/com.apple.alf stealthenabled -int 0
    sudo_run pkill -HUP socketfilterfw 2>/dev/null || true
    sudo_run "$SFW" --setglobalstate off >/dev/null 2>&1 || true
    sleep 1
    sudo_run "$SFW" --setglobalstate on >/dev/null 2>&1 || true
    sleep 1
    ;;
esac
CUR="$("$SFW" --getstealthmode 2>/dev/null)"
case "$CUR" in
  *off*)
    mflog "firewall stealth mode disabled (was $WAS)"
    echo "Stealth mode disabled - the Mac now answers inbound connections (firewall itself stays on)."
    ;;
  *)
    echo '!! Stealth mode still reports ON. Toggle it by hand: System Settings -> Network -> Firewall -> Options -> disable "Enable stealth mode".'
    exit 1
    ;;
esac
`,
      revert: `
SFW=/usr/libexec/ApplicationFirewall/socketfilterfw
PREV="$(get_state stealth_prev)"
if [ "$PREV" != "on" ]; then echo "Stealth mode was not changed by setup - leaving it as is."; del_state stealth_prev; exit 0; fi
sudo_run "$SFW" --setstealthmode on >/dev/null 2>&1 || true
sleep 1
CUR="$("$SFW" --getstealthmode 2>/dev/null)"
case "$CUR" in
  *on*) ;;
  *)
    sudo_run defaults write /Library/Preferences/com.apple.alf stealthenabled -int 1
    sudo_run pkill -HUP socketfilterfw 2>/dev/null || true
    sudo_run "$SFW" --setglobalstate off >/dev/null 2>&1 || true
    sleep 1
    sudo_run "$SFW" --setglobalstate on >/dev/null 2>&1 || true
    ;;
esac
del_state stealth_prev
mflog "firewall stealth mode restored to on"
echo "Stealth mode re-enabled."
`,
    },
    {
      id: "tunnel",
      title: "Tunnel up & verified",
      description:
        "Brings wg0 up now (the daemon handles reboots) and pings the VPN gateway to prove the path works.",
      kind: "auto",
      needsVpn: true,
      runNeedsSudo: true,
      run: `
BREW="$(find_brew)" || { echo '!! Homebrew is required first'; exit 1; }
BREWBIN="$(dirname "$BREW")"
WGQUICK="$BREWBIN/wg-quick"
[ -x "$WGQUICK" ] || { echo '!! wg-quick not found - install WireGuard tools first'; exit 1; }
"$BREW" list bash >/dev/null 2>&1 || "$BREW" install bash
BASH5="$BREWBIN/bash"
[ -x "$BASH5" ] || { echo '!! Homebrew bash not found after install'; exit 1; }
UP_OUT="$(sudo_run env PATH="$BREWBIN:/usr/bin:/bin:/usr/sbin:/sbin" "$BASH5" "$WGQUICK" up wg0 2>&1)" || {
  if printf '%s' "$UP_OUT" | grep -qi 'already exists'; then
    echo "(tunnel already up)"
  else
    printf '%s\\n' "$UP_OUT"
    echo '!! wg-quick up failed'
    exit 1
  fi
}
[ -n "$UP_OUT" ] && printf '%s\\n' "$UP_OUT"
echo "Pinging VPN gateway ${gatewayIp}..."
if ping -c 3 -t 5 ${gatewayIp}; then
  echo "Tunnel is up - gateway reachable."
else
  echo "!! Gateway unreachable. Most common cause: the Mac peer is not registered on the WireGuard server yet."
  exit 1
fi
`,
    },
    {
      // Runs on the PRODUCTION host (caimon), not the Mac — the run route
      // special-cases this id and targets the swarm host from the deploy
      // config (.docker/.config.env.tools). Root over SSH, so no sudo dance.
      id: "prodvpn",
      title: "Production host VPN (caimon)",
      description:
        "Joins the production swarm host to the VPN so it can reach the Mac's tunnel address: installs wireguard-tools, writes a split-tunnel wg0.conf, registers the peer on the WireGuard server, enables autostart (systemd), and verifies it can reach the Mac's SSH port through the tunnel. Uses the deploy config's SSH credentials.",
      kind: "auto",
      needsVpn: true,
      run: `
export DEBIAN_FRONTEND=noninteractive
if ! command -v wg >/dev/null 2>&1; then
  echo "Installing wireguard-tools..."
  apt-get install -y -qq wireguard-tools >/dev/null 2>&1 || apt-get install -y wireguard-tools
fi
command -v wg >/dev/null 2>&1 || { echo '!! could not install wireguard-tools'; exit 1; }
mkdir -p /etc/wireguard
if [ ! -f /etc/wireguard/wg0.conf ]; then
  umask 077
  PRIV="$(wg genkey)"
  cat > /etc/wireguard/wg0.conf <<WGEOF
[Interface]
PrivateKey = $PRIV
Address = ${prodIp}/${mask}

[Peer]
PublicKey = ${serverPub}
Endpoint = ${endpoint}
AllowedIPs = ${subnet}
PersistentKeepalive = 25
WGEOF
  chmod 600 /etc/wireguard/wg0.conf
  echo "Wrote /etc/wireguard/wg0.conf (address ${prodIp})"
else
  echo "/etc/wireguard/wg0.conf already exists - keeping it."
fi
PRIV2="$(awk '/^PrivateKey/ {print \$3}' /etc/wireguard/wg0.conf)"
PUB="$(printf '%s' "$PRIV2" | wg pubkey)"
systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
systemctl restart wg-quick@wg0 2>/dev/null || wg-quick up wg0 2>/dev/null || true
mflog "prodvpn configured (pubkey $PUB)"
echo "::PUBKEY-PROD::$PUB"
`,
      revert: `
if [ -f /etc/wireguard/wg0.conf ]; then
  PRIV2="$(awk '/^PrivateKey/ {print \$3}' /etc/wireguard/wg0.conf)"
  PUB="$(printf '%s' "$PRIV2" | wg pubkey 2>/dev/null || true)"
  [ -n "$PUB" ] && echo "::PUBKEY-PROD-REMOVE::$PUB"
fi
systemctl disable --now wg-quick@wg0 2>/dev/null || wg-quick down wg0 2>/dev/null || echo "(tunnel was not up)"
rm -f /etc/wireguard/wg0.conf
mflog "prodvpn reverted"
echo "Removed production VPN config."
`,
    },
  ];
}

// After the prod peer is registered, prove the path that builds will use:
// caimon → VPN server → Mac's SSH port.
function prodVerifyScript(): string {
  const gatewayIp = cfg(env.VPN_GATEWAY_IP, "VPN_GATEWAY_IP");
  const macIp = cfg(env.VPN_MAC_IP, "VPN_MAC_IP");
  return `
echo "Pinging VPN gateway ${gatewayIp} from the production host..."
ping -c 2 -W 2 ${gatewayIp} >/dev/null 2>&1 && echo "gateway reachable" || echo "(gateway ping failed - continuing)"
echo "Checking the Mac's SSH port through the tunnel (${macIp}:22)..."
sleep 2
if timeout 6 bash -c "echo > /dev/tcp/${macIp}/22" 2>/dev/null; then
  echo "Mac SSH reachable from production - the build path works."
else
  echo "!! Cannot reach ${macIp}:22 from the production host."
  echo "   Check that the Mac's tunnel is up and the VPN server forwards peer-to-peer traffic."
  exit 1
fi
`;
}

// Detection: one SSH round trip that reports every step's state as TSV lines,
// then dumps the state file and the provision log tail for the UI.
function detectScript(): string {
  const gatewayIp = vpnConfigured() ? cfg(env.VPN_GATEWAY_IP, "VPN_GATEWAY_IP") : "";
  return `${PRELUDE}
put() { printf 'STEP\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3"; }
put connect ok "macOS $(sw_vers -productVersion 2>/dev/null || uname -sr)"
if command -v xcodebuild >/dev/null 2>&1 && XCV="$(xcodebuild -version 2>/dev/null | tr '\\n' ' ')"; then
  put xcode ok "$XCV"
else
  put xcode missing "Xcode not installed, or license not accepted"
fi
BREW="$(find_brew || true)"
if [ -n "$BREW" ]; then
  put homebrew ok "$("$BREW" --version 2>/dev/null | head -1)"
  eval "$("$BREW" shellenv)"
else
  put homebrew missing "brew not found in /opt/homebrew or /usr/local"
fi
MISSING=""
for t in git pod xcbeautify; do command -v "$t" >/dev/null 2>&1 || MISSING="$MISSING $t"; done
if [ -z "$MISSING" ]; then put buildtools ok "git, pod, xcbeautify present"; else put buildtools missing "missing:$MISSING"; fi
if command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1; then
  put wireguard ok "$(wg --version 2>/dev/null | head -1)"
else
  put wireguard missing "wireguard-tools not installed"
fi
CONF=""
[ -n "$BREW" ] && CONF="$("$BREW" --prefix)/etc/wireguard/wg0.conf"
if [ -n "$CONF" ] && [ -e "$CONF" ]; then put vpnconf ok "$CONF"; else put vpnconf missing "wg0.conf not written"; fi
PLIST=/Library/LaunchDaemons/com.mobileflow.wg0.plist
if [ -e "$PLIST" ]; then put vpndaemon ok "installed"; else put vpndaemon missing "autostart daemon not installed"; fi
SLEEPV="$(pmset -g 2>/dev/null | awk '$1=="sleep"{print $2; exit}')"
if [ "$SLEEPV" = "0" ]; then put keepawake ok "system sleep disabled"; else put keepawake missing "system sleep=$SLEEPV"; fi
STEALTH="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode 2>/dev/null)"
case "$STEALTH" in
  *on*) put firewall missing "stealth mode on - drops inbound SSH from the tunnel" ;;
  *) put firewall ok "stealth mode off" ;;
esac
GW="${gatewayIp}"
if [ -n "$GW" ]; then
  if ping -c 1 -t 3 "$GW" >/dev/null 2>&1; then put tunnel ok "gateway $GW reachable"; else put tunnel missing "cannot reach VPN gateway $GW"; fi
else
  put tunnel unknown "VPN_* env not configured on the API"
fi
echo STATE_BEGIN
cat "$MF_DIR/provision.state" 2>/dev/null || true
echo STATE_END
echo LOG_BEGIN
tail -40 "$MF_DIR/provision.log" 2>/dev/null || true
echo LOG_END
`;
}

// ---------------------------------------------------------------------------
// SSH plumbing
// ---------------------------------------------------------------------------

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const bashLC = (script: string) => `bash -lc ${shq(script)}`;

/** Belt-and-suspenders: never let key material into a streamed log line. */
function redact(line: string): string {
  return line.replace(/PrivateKey\s*=\s*\S+/g, "PrivateKey = [redacted]");
}

/**
 * exec that can feed stdin (the sudo password) and captures ::MARKER:: lines.
 * Local to this module — the worker's exec() doesn't expose the stream.
 */
function execScript(
  ssh: import("ssh2").Client,
  script: string,
  stdinLine: string | null,
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    ssh.exec(bashLC(script), { pty: false }, (err, stream) => {
      if (err) return reject(err);
      if (stdinLine !== null) stream.write(`${stdinLine}\n`);
      let out = "";
      let errBuf = "";
      const flush = (buf: string, isErr: boolean) => {
        const lines = buf.split(/\r?\n/);
        const tail = lines.pop() ?? "";
        for (const l of lines) if (l.length > 0) onLine(isErr ? `! ${l}` : l);
        return tail;
      };
      stream
        .on("data", (c: Buffer) => { out = flush(out + c.toString("utf8"), false); })
        .on("close", (code: number | null) => {
          if (out) onLine(out);
          if (errBuf) onLine(`! ${errBuf}`);
          resolve(code ?? -1);
        })
        .stderr.on("data", (c: Buffer) => { errBuf = flush(errBuf + c.toString("utf8"), true); });
    });
  });
}

async function macTargetFor(hostId: string): Promise<{ target: SshTarget; row: typeof buildHosts.$inferSelect } | null> {
  const [row] = await db.select().from(buildHosts).where(eq(buildHosts.id, hostId)).limit(1);
  if (!row || row.kind !== "mac") return null;
  return {
    row,
    target: {
      host: row.hostname,
      port: row.port,
      username: row.sshUser,
      privateKey: Buffer.from(decryptString(row.sshKeyEnc), "utf8"),
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory jobs (one running per host)
// ---------------------------------------------------------------------------

interface SetupJob {
  id: string;
  hostId: string;
  stepId: string;
  revert: boolean;
  state: "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  lines: { seq: number; text: string }[];
  seq: number;
}

const setupJobs = new Map<string, SetupJob>();
const MAX_SETUP_JOBS = 20;

function pushLine(job: SetupJob, text: string) {
  job.lines.push({ seq: ++job.seq, text: redact(text) });
  if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
}

function runningJobFor(hostId: string): SetupJob | null {
  for (const j of setupJobs.values()) if (j.hostId === hostId && j.state === "running") return j;
  return null;
}

/**
 * Register / deregister the Mac's peer on the WireGuard server. Fires when a
 * ::PUBKEY:: / ::PUBKEY-REMOVE:: marker shows up in the step output. When the
 * VPS SSH env isn't configured, prints the manual commands instead.
 */
const WG_KEY_RE = /^[A-Za-z0-9+/=]{40,60}$/;
async function syncVpsPeer(job: SetupJob, pubkey: string, remove: boolean, peerIp?: string): Promise<boolean> {
  if (!WG_KEY_RE.test(pubkey)) {
    pushLine(job, `! unexpected public key format — skipping server registration`);
    return false;
  }
  const macIp = peerIp ?? cfg(env.VPN_MAC_IP, "VPN_MAC_IP");
  const target = vpsTarget();
  if (!target) {
    pushLine(job, "");
    pushLine(job, remove
      ? "VPN_VPS_* not configured — remove the peer on the WireGuard server yourself:"
      : "VPN_VPS_* not configured — register the peer on the WireGuard server yourself:");
    pushLine(job, remove
      ? `  wg set wg0 peer '${pubkey}' remove && wg-quick save wg0`
      : `  wg set wg0 peer '${pubkey}' allowed-ips '${macIp}/32' && wg-quick save wg0`);
    return false;
  }
  pushLine(job, `Connecting to WireGuard server ${target.host} to ${remove ? "remove" : "register"} the peer…`);
  const cmd = remove
    ? `wg set wg0 peer '${pubkey}' remove && (wg-quick save wg0 2>/dev/null || true) && echo peer-removed`
    : `wg set wg0 peer '${pubkey}' allowed-ips '${macIp}/32' && (wg-quick save wg0 2>/dev/null || true) && echo peer-registered`;
  try {
    const code = await withSsh(target, (ssh) => execScript(ssh, cmd, null, (l) => pushLine(job, `[vps] ${l}`)));
    if (code !== 0) {
      pushLine(job, `! peer ${remove ? "removal" : "registration"} on the server exited ${code}`);
      return false;
    }
    return true;
  } catch (err) {
    pushLine(job, `! could not reach the WireGuard server: ${(err as Error).message}`);
    return false;
  }
}

/** Read the Mac's recorded WireGuard public key from its provisioning state. */
async function readMacPubkey(target: SshTarget): Promise<string | null> {
  let pub: string | null = null;
  const script = `${PRELUDE}
PUB="$(get_state wg_public_key)"
[ -n "$PUB" ] && echo "::PUBKEY::$PUB"
`;
  await withSsh(target, (ssh) =>
    execScript(ssh, script, null, (line) => {
      if (line.startsWith("::PUBKEY::")) pub = line.slice("::PUBKEY::".length).trim();
    }),
  );
  return pub;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Same dev-only stance as localDeploy: this SSHes around your home network. */
function setupEnabled(): boolean {
  return !env.isProd || env.ADMIN_LOCAL_DEPLOY;
}

export async function hostSetupRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireSuperadmin);
  server.addHook("preHandler", async (_req, reply) => {
    if (!setupEnabled()) {
      return reply.forbidden(
        "Host setup is disabled on this API. It provisions machines over SSH, so it's development-only unless ADMIN_LOCAL_DEPLOY=true.",
      );
    }
  });

  // Detection: SSH in, evaluate every step, return statuses + manifest.
  server.get<{ Params: { id: string } }>("/admin/hosts/:id/setup", async (req, reply) => {
    const resolved = await macTargetFor(req.params.id);
    if (!resolved) return reply.notFound("Mac build host not found (env-defined hosts are not supported)");

    const defs = stepDefs();
    const statuses = new Map<string, { status: StepStatus; detail: string }>();
    const state = new Map<string, string>();
    const history: string[] = [];

    let reachable = true;
    let connectError = "";
    try {
      let section: "steps" | "state" | "log" = "steps";
      await withSsh(resolved.target, (ssh) =>
        execScript(ssh, detectScript(), null, (line) => {
          if (line === "STATE_BEGIN") { section = "state"; return; }
          if (line === "STATE_END") { section = "steps"; return; }
          if (line === "LOG_BEGIN") { section = "log"; return; }
          if (line === "LOG_END") { section = "steps"; return; }
          if (section === "state") {
            const idx = line.indexOf("=");
            if (idx > 0) state.set(line.slice(0, idx), line.slice(idx + 1));
            return;
          }
          if (section === "log") {
            history.push(line);
            return;
          }
          if (line.startsWith("STEP\t")) {
            const [, id, status, detail] = line.split("\t");
            if (id) statuses.set(id, { status: (status as StepStatus) ?? "unknown", detail: detail ?? "" });
          }
        }),
      );
    } catch (err) {
      reachable = false;
      connectError = (err as Error).message;
    }

    const serverAccess = await vpsAccess();
    const vpn = {
      configured: vpnConfigured(),
      autoRegister: serverAccess === "ok",
      serverAccess,
      vpsHost: env.VPN_VPS_HOST ?? null,
      vpsUser: env.VPN_VPS_USER,
      endpoint: env.VPN_SERVER_ENDPOINT ?? null,
      subnet: env.VPN_SUBNET,
      gatewayIp: env.VPN_GATEWAY_IP,
      macIp: env.VPN_MAC_IP ?? null,
    };

    // Peer registration lives on the WireGuard server, not the Mac — check it
    // there when the API can log in.
    if (reachable) {
      const pub = state.get("wg_public_key");
      if (!vpn.configured) {
        statuses.set("vpnpeer", { status: "unknown", detail: "VPN_* env not configured on the API" });
      } else if (serverAccess !== "ok") {
        statuses.set("vpnpeer", {
          status: "unknown",
          detail:
            serverAccess === "unreachable"
              ? "VPN server unreachable"
              : "no server access yet — set it up in “VPN server access” above",
        });
      } else if (!pub) {
        statuses.set("vpnpeer", { status: "missing", detail: "no key recorded yet — run VPN tunnel config first" });
      } else {
        try {
          let found = false;
          await withSsh(vpsTarget()!, (ssh) =>
            execScript(ssh, "wg show wg0 peers", null, (l) => {
              if (l.trim() === pub) found = true;
            }),
          );
          statuses.set(
            "vpnpeer",
            found
              ? { status: "ok", detail: "peer registered on the VPN server" }
              : { status: "missing", detail: "peer not registered on the VPN server" },
          );
        } catch (err) {
          statuses.set("vpnpeer", { status: "error", detail: `cannot reach VPN server: ${(err as Error).message}` });
        }
      }
    }

    // Production host: is it a VPN member that can reach the Mac's SSH port?
    if (reachable) {
      const pt = prodTarget();
      if (!vpn.configured) {
        statuses.set("prodvpn", { status: "unknown", detail: "VPN_* env not configured on the API" });
      } else if (!pt) {
        statuses.set("prodvpn", { status: "unknown", detail: "deploy config (.docker/.config.env.tools) not found" });
      } else {
        try {
          let line = "";
          const macIp = cfg(env.VPN_MAC_IP, "VPN_MAC_IP");
          await withSsh(pt, (ssh) =>
            execScript(
              ssh,
              `if ! command -v wg >/dev/null 2>&1; then echo 'missing|wireguard-tools not installed'; ` +
                `elif ! wg show wg0 >/dev/null 2>&1; then echo 'missing|wg0 tunnel not up'; ` +
                `elif timeout 5 bash -c "echo > /dev/tcp/${macIp}/22" 2>/dev/null; then echo 'ok|tunnel up, Mac SSH reachable'; ` +
                `else echo 'missing|tunnel up but cannot reach Mac ${macIp}:22'; fi`,
              null,
              (l) => { if (l.includes("|")) line = l; },
            ),
          );
          const [st, detail] = line.split("|");
          statuses.set("prodvpn", { status: (st as StepStatus) || "unknown", detail: detail ?? "" });
        } catch (err) {
          statuses.set("prodvpn", { status: "error", detail: `cannot reach production host: ${(err as Error).message}` });
        }
      }
    }

    const canRevert = (id: string): boolean => {
      switch (id) {
        case "buildtools": return state.has("buildtools_installed");
        case "wireguard": return state.has("wireguard_installed");
        case "vpnconf": return state.has("wg_public_key") || statuses.get("vpnconf")?.status === "ok";
        case "vpnpeer": return !!vpsTarget() && statuses.get("vpnpeer")?.status === "ok";
        case "prodvpn": {
          const st = statuses.get("prodvpn");
          return !!prodTarget() && (st?.status === "ok" || st?.detail?.includes("cannot reach Mac") === true);
        }
        case "vpndaemon": return statuses.get("vpndaemon")?.status === "ok";
        case "keepawake": return state.has("pmset_prev_sleep");
        case "firewall": return state.has("stealth_prev");
        default: return false;
      }
    };

    return {
      enabled: true,
      reachable,
      connectError: reachable ? null : connectError,
      hostname: resolved.row.hostname,
      vpn,
      steps: defs.map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        kind: d.kind,
        runNeedsSudo: !!d.runNeedsSudo,
        revertNeedsSudo: !!d.revertNeedsSudo,
        needsVpn: !!d.needsVpn,
        canRun:
          d.kind === "auto" &&
          reachable &&
          (!d.needsVpn || vpn.configured) &&
          (d.id === "vpnpeer"
            ? vpn.autoRegister && state.has("wg_public_key")
            : d.id === "prodvpn"
              ? vpn.autoRegister && !!prodTarget()
              : !!d.run),
        canRevert: reachable && (!!d.revert || d.id === "vpnpeer") && canRevert(d.id),
        ...(reachable
          ? statuses.get(d.id) ?? { status: "unknown" as StepStatus, detail: "" }
          : {
              status: (d.id === "connect" ? "missing" : "unknown") as StepStatus,
              detail: d.id === "connect" ? connectError : "host unreachable",
            }),
      })),
      history,
      runningJobId: runningJobFor(resolved.row.id)?.id ?? null,
    };
  });

  // Run (or revert) one step. 202 + jobId; poll the job endpoint for output.
  server.post<{ Params: { id: string } }>("/admin/hosts/:id/setup/run", async (req, reply) => {
    const Body = z.object({
      stepId: z.string().min(1).max(40),
      revert: z.boolean().default(false),
      // Held in memory for this job only; fed to `sudo -S` via stdin.
      sudoPassword: z.string().min(1).max(256).optional(),
    });
    const body = Body.parse(req.body ?? {});

    const resolved = await macTargetFor(req.params.id);
    if (!resolved) return reply.notFound("Mac build host not found");
    const def = stepDefs().find((d) => d.id === body.stepId);
    if (!def) return reply.notFound("Unknown setup step");
    const isPeerStep = def.id === "vpnpeer";
    const isProdStep = def.id === "prodvpn";
    const script = body.revert ? def.revert : def.run;
    if (!script && !isPeerStep) {
      return reply.badRequest(body.revert ? "Step has no revert action" : "Step is manual — nothing to run");
    }
    if (def.needsVpn && !body.revert && !vpnConfigured()) {
      return reply.badRequest("VPN_SERVER_ENDPOINT / VPN_SERVER_PUBLIC_KEY / VPN_MAC_IP must be configured on the API first");
    }
    if ((isPeerStep || isProdStep) && !vpsTarget()) {
      return reply.badRequest("VPN_VPS_HOST / VPN_VPS_SSH_KEY_PATH must be configured on the API first");
    }
    const prodSsh = isProdStep ? prodTarget() : null;
    if (isProdStep && !prodSsh) {
      return reply.badRequest("Production host credentials not found — check .docker/.config.env.tools (CLOUD_HOST, SSH_KEY)");
    }
    const needsSudo = body.revert ? def.revertNeedsSudo : def.runNeedsSudo;
    if (needsSudo && !body.sudoPassword) {
      return reply.badRequest("This step needs the Mac's admin (sudo) password");
    }
    if (runningJobFor(resolved.row.id)) {
      return reply.conflict("A setup step is already running on this host");
    }

    const job: SetupJob = {
      id: randomUUID(),
      hostId: resolved.row.id,
      stepId: def.id,
      revert: body.revert,
      state: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      lines: [],
      seq: 0,
    };
    setupJobs.set(job.id, job);
    while (setupJobs.size > MAX_SETUP_JOBS) {
      const oldest = [...setupJobs.entries()].find(([, j]) => j.state !== "running");
      if (!oldest) break;
      setupJobs.delete(oldest[0]);
    }

    pushLine(job, `${body.revert ? "Reverting" : "Running"}: ${def.title}`);
    const fullScript = PRELUDE + (needsSudo ? SUDO_PRELUDE : "") + (script ?? "");
    const sudoPw = needsSudo ? body.sudoPassword! : null;

    // Fire and stream; the client polls.
    void (async () => {
      try {
        if (isPeerStep) {
          // Register/remove the Mac's peer on the WireGuard server.
          const pub = await readMacPubkey(resolved.target);
          if (!pub) {
            job.state = "failed";
            pushLine(job, "! no WireGuard key recorded on the Mac — run “VPN tunnel config (wg0)” first");
            return;
          }
          pushLine(job, `Mac public key: ${pub}`);
          const ok = await syncVpsPeer(job, pub, body.revert);
          job.exitCode = ok ? 0 : 1;
          job.state = ok ? "succeeded" : "failed";
          pushLine(job, ok ? "✔ step finished" : "✖ step failed");
          return;
        }

        if (isProdStep) {
          // Runs on the production swarm host (root), then registers/removes
          // its peer on the WireGuard server, then verifies caimon → Mac:22.
          let prodPub: string | null = null;
          let prodPubRemove: string | null = null;
          const code = await withSsh(prodSsh!, (ssh) =>
            execScript(ssh, PRELUDE + script!, null, (line) => {
              if (line.startsWith("::PUBKEY-PROD::")) {
                prodPub = line.slice("::PUBKEY-PROD::".length).trim();
                return;
              }
              if (line.startsWith("::PUBKEY-PROD-REMOVE::")) {
                prodPubRemove = line.slice("::PUBKEY-PROD-REMOVE::".length).trim();
                return;
              }
              pushLine(job, line);
            }),
          );
          if (code !== 0) {
            job.exitCode = code;
            job.state = "failed";
            pushLine(job, `✖ step failed (exit ${code})`);
            return;
          }
          let ok = true;
          if (prodPubRemove) {
            ok = await syncVpsPeer(job, prodPubRemove, true, env.VPN_PROD_IP);
          }
          if (prodPub) {
            pushLine(job, `Production host public key: ${prodPub}`);
            ok = await syncVpsPeer(job, prodPub, false, env.VPN_PROD_IP);
            if (ok) {
              const vcode = await withSsh(prodSsh!, (ssh) =>
                execScript(ssh, prodVerifyScript(), null, (line) => pushLine(job, line)),
              );
              ok = vcode === 0;
            }
          }
          job.exitCode = ok ? 0 : 1;
          job.state = ok ? "succeeded" : "failed";
          pushLine(job, ok ? "✔ step finished" : "✖ step failed");
          return;
        }

        const markers: { pubkey: string; remove: boolean }[] = [];
        const code = await withSsh(resolved.target, (ssh) =>
          execScript(ssh, fullScript, sudoPw, (line) => {
            if (line.startsWith("::PUBKEY::")) {
              markers.push({ pubkey: line.slice("::PUBKEY::".length).trim(), remove: false });
              return; // marker is plumbing, not log content
            }
            if (line.startsWith("::PUBKEY-REMOVE::")) {
              markers.push({ pubkey: line.slice("::PUBKEY-REMOVE::".length).trim(), remove: true });
              return;
            }
            pushLine(job, line);
          }),
        );
        for (const m of markers) await syncVpsPeer(job, m.pubkey, m.remove);
        job.exitCode = code;
        job.state = code === 0 ? "succeeded" : "failed";
        pushLine(job, code === 0 ? "✔ step finished" : `✖ step failed (exit ${code})`);
      } catch (err) {
        job.state = "failed";
        pushLine(job, `! ${(err as Error).message}`);
      } finally {
        job.endedAt = new Date().toISOString();
      }
    })();

    writeAdminLog(
      "admin_host_setup.started",
      { host_id: resolved.row.id, step: def.id, revert: body.revert, job_id: job.id },
      req.auth?.userId,
    );
    return reply.code(202).send({ jobId: job.id });
  });

  // Store the VPS private key (dropped/picked in the UI) at the configured
  // path, then report whether the server accepts it. 0600 like ssh expects.
  server.post("/admin/hosts/:id/setup/vps-key", async (req, reply) => {
    const Body = z.object({ key: z.string().min(50).max(20_000) });
    const body = Body.parse(req.body ?? {});
    const pem = body.key.replace(/\r\n/g, "\n");
    const parsed = sshUtils.parseKey(pem);
    if (parsed instanceof Error) {
      return reply.badRequest(`That file doesn't look like a private key: ${parsed.message}`);
    }
    if (!env.VPN_VPS_HOST) {
      return reply.badRequest("Set VPN_VPS_HOST in the API's .env first");
    }
    const path = vpsKeyPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, pem.endsWith("\n") ? pem : `${pem}\n`, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort on Windows mounts */ }
    writeAdminLog("admin_host_setup.vps_key_stored", { path }, req.auth?.userId);
    const access = await vpsAccess();
    return { stored: true, access };
  });

  // One-time bootstrap: log into the VPS with a password, install the stored
  // key's public half into authorized_keys, verify key auth works, and forget
  // the password. After this the buttons run on key auth alone.
  server.post("/admin/hosts/:id/setup/vps-authorize", async (req, reply) => {
    const Body = z.object({ password: z.string().min(1).max(256) });
    const body = Body.parse(req.body ?? {});
    if (!env.VPN_VPS_HOST) return reply.badRequest("Set VPN_VPS_HOST in the API's .env first");
    const pubLine = vpsPublicKeyLine();
    if (!pubLine) return reply.badRequest("No VPS key stored yet — upload the private key first");
    // The base64 blob is unique enough for the dedupe grep and contains no
    // characters that need shell quoting.
    const blob = pubLine.split(" ")[1] ?? "";
    const cmd =
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && ` +
      `(grep -qF '${blob}' ~/.ssh/authorized_keys || printf '%s\\n' '${pubLine}' >> ~/.ssh/authorized_keys) && ` +
      `chmod 600 ~/.ssh/authorized_keys && echo key-installed`;
    try {
      const res = await execWithPassword(
        { host: env.VPN_VPS_HOST, port: env.VPN_VPS_PORT, username: env.VPN_VPS_USER, password: body.password },
        cmd,
      );
      if (res.code !== 0) {
        return reply.code(200).send({ ok: false, error: `install failed (exit ${res.code}): ${res.output.slice(0, 300)}` });
      }
    } catch (err) {
      return reply.code(200).send({ ok: false, error: `could not log in with that password: ${(err as Error).message}` });
    }
    const access = await vpsAccess();
    writeAdminLog("admin_host_setup.vps_key_authorized", { host: env.VPN_VPS_HOST }, req.auth?.userId);
    return { ok: access === "ok", access, ...(access !== "ok" ? { error: "key installed but key-auth still fails" } : {}) };
  });

  server.get<{ Params: { id: string; jobId: string }; Querystring: { since?: string } }>(
    "/admin/hosts/:id/setup/jobs/:jobId",
    async (req, reply) => {
      const job = setupJobs.get(req.params.jobId);
      if (!job || job.hostId !== req.params.id) return reply.notFound("Unknown setup job");
      const since = Number(req.query.since ?? 0);
      return {
        id: job.id,
        stepId: job.stepId,
        revert: job.revert,
        state: job.state,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        exitCode: job.exitCode,
        lines: Number.isFinite(since) && since > 0 ? job.lines.filter((l) => l.seq > since) : job.lines,
      };
    },
  );
}
