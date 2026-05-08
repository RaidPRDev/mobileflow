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
  COOKIE_SECRET: z.string().min(16),
  SUPERADMIN_EMAIL: z.string().email().optional(),
  API_BASE_URL: z.string().url().default("http://127.0.0.1:4000"),
  WEB_BASE_URL: z.string().url().default("http://127.0.0.1:5173"),
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
  MAC_BUILD_HOST: z.string().optional(),
  MAC_BUILD_PORT: z.coerce.number().int().positive().default(22),
  MAC_BUILD_USER: z.string().optional(),
  MAC_BUILD_SSH_KEY_PATH: z.string().optional(),
  MAC_BUILD_SSH_KEY: z.string().optional(),
  MAC_BUILD_REMOTE_BASE: z.string().default("/Users/build/RaidX/Clients"),
  MAC_BUILD_DOWNLOADS_BASE: z.string().default("/Users/build/RaidX/downloads"),
  MAC_BUILD_DOWNLOADS_BASE_URL: z.string().default("https://xbuilds.raidpr.com"),
  MAC_BUILD_TOOLS: z.string().default("/Users/build/RaidX/Tools"),
  LINUX_BUILD_WEB_IMAGE: z.string().default("node:20-alpine"),
  LINUX_BUILD_WEB_COMMAND: z.string().default("npm ci && npm run build"),
  LINUX_BUILD_WEB_DIST_DIR: z.string().default("dist"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_BOHIO: z.string().optional(),
  STRIPE_PRICE_YUCAYEQUE: z.string().optional(),
  STRIPE_PRICE_CACIQUE: z.string().optional(),
});

const parsed = Schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  WEB_ORIGINS: parsed.data.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === "production",
};
