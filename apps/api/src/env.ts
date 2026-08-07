import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

function loadDotEnv() {
  if (process.env.NODE_ENV === "production" && process.env.SKIP_DOTENV) return;
  for (const candidate of [".env", ".env.local"]) {
    try {
      const text = readFileSync(resolve(process.cwd(), candidate), "utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq < 0) continue;
        const k = line.slice(0, eq).trim();
        let v = line.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (process.env[k] === undefined) process.env[k] = v;
      }
    } catch {
      // file not present — fine
    }
  }
}

loadDotEnv();

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("127.0.0.1"),
  WEB_ORIGIN: z.string().default("http://127.0.0.1:5173,http://localhost:5173"),
  DATABASE_URL: z.string().url(),
  // 32 chars is the floor for an HMAC key; the cookie plugin uses this to
  // sign anything we choose to mark `signed: true`. In production we also
  // refuse the well-known dev default below in the post-parse step.
  COOKIE_SECRET: z.string().min(32),
  SUPERADMIN_EMAIL: z.string().email().optional(),
  // Length is not enforced at the schema level so dev .env files with weak
  // bootstrap credentials still work. Production enforces min length and
  // presence in the post-parse block below; dev/test can use whatever.
  SUPERADMIN_PASSWORD: z.string().optional(),
  TESTERCLIENT_EMAIL: z.string().email().optional(),
  TESTERCLIENT_PASSWORD: z.string().optional(),
  // Admin → Deploy runs this repo's deploy scripts as child processes of the
  // API. That belongs to a developer's own machine, so the routes are refused
  // when NODE_ENV=production unless this is deliberately turned on.
  ADMIN_LOCAL_DEPLOY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Comma-separated list of CIDRs / IPs the API will trust X-Forwarded-* from.
  // Default is loopback only, which is correct for "API listens on 127.0.0.1
  // behind nginx on the same box". For multi-host deploys, set this to the
  // proxy IP(s). `false` disables proxy trust entirely. NEVER set to "true"
  // in production — that lets a client spoof their own IP via header.
  TRUST_PROXY: z.string().default("loopback"),
  API_BASE_URL: z.string().url().default("http://127.0.0.1:4000"),
  WEB_BASE_URL: z.string().url().default("http://127.0.0.1:5173"),
  LOG_DIR: z.string().min(1).default("logs"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GITHUB_GIT_CLIENT_ID: z.string().optional(),
  GITHUB_GIT_CLIENT_SECRET: z.string().optional(),
  TOKEN_ENC_KEY: z
    .string()
    .regex(/^([0-9a-fA-F]{64})?$/, "TOKEN_ENC_KEY must be 32 bytes hex (64 chars) or empty")
    .optional(),
  LINUX_BUILD_HOST: z.string().optional(),
  LINUX_BUILD_PORT: z.coerce.number().int().positive().default(22),
  LINUX_BUILD_USER: z.string().default("root"),
  LINUX_BUILD_SSH_KEY_PATH: z.string().optional(),
  LINUX_BUILD_SSH_KEY: z.string().optional(),
  LINUX_BUILD_REMOTE_BASE: z.string().default("/root/RaidX/Clients"),
  LINUX_BUILD_DOWNLOADS_BASE: z.string().default("/root/RaidX/downloads"),
  LINUX_BUILD_DOWNLOADS_BASE_URL: z.string().default("https://xbuilds.raidpr.com"),
  LINUX_BUILD_ANDROID_IMAGE: z.string().default("raidx-android-builder:latest"),
  LINUX_BUILD_ANDROID_TOOLS: z.string().default("/root/RaidX/Tools/android"),
  // Max concurrent builds on the env-defined hosts (DB hosts carry their own
  // capacity column). The worker leaves builds queued once this many are
  // running on the host.
  LINUX_BUILD_CAPACITY: z.coerce.number().int().positive().default(2),
  MAC_BUILD_HOST: z.string().optional(),
  MAC_BUILD_PORT: z.coerce.number().int().positive().default(22),
  MAC_BUILD_USER: z.string().optional(),
  MAC_BUILD_SSH_KEY_PATH: z.string().optional(),
  MAC_BUILD_SSH_KEY: z.string().optional(),
  MAC_BUILD_REMOTE_BASE: z.string().default("/Users/build/RaidX/Clients"),
  MAC_BUILD_DOWNLOADS_BASE: z.string().default("/Users/build/RaidX/downloads"),
  MAC_BUILD_DOWNLOADS_BASE_URL: z.string().default("https://xbuilds.raidpr.com"),
  MAC_BUILD_TOOLS: z.string().default("/Users/build/RaidX/Tools"),
  MAC_BUILD_CAPACITY: z.coerce.number().int().positive().default(2),
  LINUX_BUILD_WEB_IMAGE: z.string().default("node:20-alpine"),
  LINUX_BUILD_WEB_COMMAND: z.string().default("npm ci && npm run build"),
  LINUX_BUILD_WEB_DIST_DIR: z.string().default("dist"),
  // ---- Mac build-host provisioning (Admin → Build hosts → Server setup) ----
  // Drives the WireGuard steps of routes/hostSetup.ts. All optional: without
  // VPN_SERVER_ENDPOINT + VPN_SERVER_PUBLIC_KEY + VPN_MAC_IP the VPN steps show
  // manual instructions instead of a Run button. VPN_VPS_* additionally lets
  // the API register/remove the Mac's peer on the WireGuard server itself;
  // without them the setup log prints the exact commands to run there by hand.
  VPN_SERVER_ENDPOINT: z.string().optional(), // host:port, e.g. "207.244.254.105:51820"
  VPN_SERVER_PUBLIC_KEY: z.string().optional(),
  VPN_SUBNET: z.string().default("10.90.90.0/24"),
  VPN_GATEWAY_IP: z.string().default("10.90.90.2"),
  VPN_MAC_IP: z.string().optional(), // tunnel address to assign the Mac, e.g. "10.90.90.3"
  VPN_PROD_IP: z.string().default("10.90.90.4"), // tunnel address for the production (caimon) host
  VPN_VPS_HOST: z.string().optional(),
  VPN_VPS_PORT: z.coerce.number().int().positive().default(22),
  VPN_VPS_USER: z.string().default("root"),
  VPN_VPS_SSH_KEY_PATH: z.string().optional(),
  // Stripe / payment-processor credentials live in the `payment_processors`
  // DB table now, configured through the Admin → Payment Processors page.
  // No payment-related env vars are read at runtime.
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const isProd = parsed.data.NODE_ENV === "production";

// Hard-fail at boot if production is missing the credentials that previously
// had weak defaults. We refuse to start rather than silently fall back, so a
// misconfigured deploy is loud, not quietly insecure.
if (isProd) {
  const missing: string[] = [];
  // When SUPERADMIN_EMAIL is configured, the seed step needs a strong
  // bootstrap password. >= 12 chars matches the OWASP "human-memorable
  // passphrase" floor. We don't require it when SUPERADMIN_EMAIL is unset
  // (the seed just skips). Same shape for TESTERCLIENT_*.
  if (parsed.data.SUPERADMIN_EMAIL) {
    const p = parsed.data.SUPERADMIN_PASSWORD;
    if (!p || p.length < 12) missing.push("SUPERADMIN_PASSWORD (>= 12 chars)");
  }
  if (parsed.data.TESTERCLIENT_EMAIL) {
    const p = parsed.data.TESTERCLIENT_PASSWORD;
    if (!p || p.length < 12) missing.push("TESTERCLIENT_PASSWORD (>= 12 chars)");
  }
  // Refuse known placeholder shapes for COOKIE_SECRET in production. The
  // schema already enforces min(32), so we don't need to catch literal short
  // placeholders — we need to catch the long ones an operator might leave
  // unrotated, like the value shipped in `.env.example`
  // (`change-me-please-32-bytes-of-random-hex`) or anyone padding "mobileflow"
  // to length by repetition.
  const cs = parsed.data.COOKIE_SECRET;
  const placeholderPatterns: RegExp[] = [
    /^change[-_ ]?me/i,
    /placeholder/i,
    /example/i,
    /^(mobileflow)+x*$/i,
    /^(?:secret|password|changeme)+x*$/i,
  ];
  if (placeholderPatterns.some((re) => re.test(cs))) {
    missing.push("COOKIE_SECRET (looks like a placeholder)");
  }
  if (missing.length > 0) {
    console.error(
      "Refusing to start in production with insecure defaults:",
      missing.join(", "),
    );
    process.exit(1);
  }
}

// Parse TRUST_PROXY: accept "false" / "loopback" / IP list. Fastify accepts
// any of these natively except we normalize "false" → boolean false.
function parseTrustProxy(raw: string): boolean | string | string[] {
  const v = raw.trim();
  if (v === "false" || v === "0" || v === "") return false;
  if (v === "true" || v === "1") {
    // Refuse a blanket `true` in production. In dev, allow it for ngrok etc.
    if (isProd) {
      console.error(
        "TRUST_PROXY=true is unsafe in production — set it to your proxy's IP(s) instead.",
      );
      process.exit(1);
    }
    return true;
  }
  if (v.includes(",")) return v.split(",").map((s) => s.trim()).filter(Boolean);
  return v; // "loopback" or single CIDR/IP — Fastify accepts strings directly
}

export const env = {
  ...parsed.data,
  WEB_ORIGINS: parsed.data.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
  TRUST_PROXY_PARSED: parseTrustProxy(parsed.data.TRUST_PROXY),
  isProd,
};
