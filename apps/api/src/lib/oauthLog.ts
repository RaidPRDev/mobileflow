import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolves to D:\dev\raidpr\apps\MobileFlow\source\mobileflow\logs\oauth.log.
// From source/mobileflow/apps/api/{src,dist}/lib/oauthLog.{ts,js}, walk up 4 levels:
// lib → src → api → apps → mobileflow.
function logDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../apps/api/src/lib (or dist/lib)
  const monorepoRoot = join(here, "..", "..", "..", "..");
  return join(monorepoRoot, "logs");
}

const LOG_PATH = join(logDir(), "oauth.log");
let ensured = false;

async function ensureDir(): Promise<void> {
  if (ensured) return;
  await fs.mkdir(logDir(), { recursive: true });
  ensured = true;
}

export async function oauthLog(event: string, data: Record<string, unknown>): Promise<void> {
  try {
    await ensureDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    await fs.appendFile(LOG_PATH, line, "utf8");
  } catch {
    // best-effort: never throw from logger
  }
}

export const OAUTH_LOG_PATH = LOG_PATH;
