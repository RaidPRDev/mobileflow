import { mkdir, readdir, rm, stat, appendFile, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { env } from "../env.js";

const GLOBAL_SCOPE = "global";
const USER_PREFIX = "user--";
const MAX_LOG_READ_BYTES = 2 * 1024 * 1024;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, "..", "..", "..", "..");

export interface LogScope {
  id: string;
  label: string;
  kind: "global" | "user";
  path: string;
  modified: number;
}

export interface LogFolder {
  name: string;
  path: string;
}

export interface LogFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export interface LogFileSnapshot {
  content: string;
  size: number;
  modified: number;
  truncated: boolean;
}

function logsRoot(): string {
  return isAbsolute(env.LOG_DIR) ? resolve(env.LOG_DIR) : resolve(REPO_ROOT, env.LOG_DIR);
}

function userScope(userId: string): string {
  return `${USER_PREFIX}${userId}`;
}

function userIdFromScope(scope: string): string | null {
  return scope.startsWith(USER_PREFIX) ? scope.slice(USER_PREFIX.length) : null;
}

function safeSegment(value: string, label = "path segment"): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(":")
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function safeScope(scope: string): string {
  if (scope === GLOBAL_SCOPE) return scope;
  if (/^user--[0-9a-fA-F-]{36}$/.test(scope)) return scope;
  throw new Error("Invalid log scope");
}

function safeYear(year: string): string {
  if (!/^\d{4}$/.test(year)) throw new Error("Invalid log year");
  return year;
}

function safeMonth(month: string): string {
  if (!/^\d{2}$/.test(month)) throw new Error("Invalid log month");
  return month;
}

function safeLogFile(file: string): string {
  safeSegment(file, "log file");
  if (!/^\d{4}-\d{2}-\d{2}-[A-Za-z0-9_.-]+\.log$/.test(file)) {
    throw new Error("Invalid log file");
  }
  return file;
}

async function ensureInsideLogs(target: string): Promise<string> {
  const root = logsRoot();
  await mkdir(root, { recursive: true });
  const [rootReal, targetReal] = await Promise.all([realpath(root), realpath(target)]);
  const rel = relative(rootReal, targetReal);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return targetReal;
  }
  throw new Error("Log path escapes logs root");
}

function scopeDir(scope: string): string {
  return join(logsRoot(), safeScope(scope));
}

function scopedMonthDir(scope: string, year: string, month: string): string {
  return join(scopeDir(scope), safeYear(year), safeMonth(month));
}

function logFilePath(scope: string, year: string, month: string, file: string): string {
  return join(scopedMonthDir(scope, year, month), safeLogFile(file));
}

async function modifiedMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

async function readSubdirs(dir: string, descending: boolean): Promise<LogFolder[]> {
  try {
    const rows = await readdir(dir, { withFileTypes: true });
    const out = rows
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: join(dir, entry.name),
      }));
    out.sort((a, b) => (descending ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
    return out;
  } catch {
    return [];
  }
}

export async function listLogScopes(): Promise<LogScope[]> {
  const root = logsRoot();
  await mkdir(root, { recursive: true });
  const [userRows, entries] = await Promise.all([
    db.select({ id: users.id, email: users.email, name: users.name }).from(users),
    readdir(root, { withFileTypes: true }).catch(() => []),
  ]);
  const existing = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  existing.add(GLOBAL_SCOPE);
  for (const u of userRows) existing.add(userScope(u.id));

  const userMap = new Map(userRows.map((u) => [userScope(u.id), u]));
  const out: LogScope[] = [];
  for (const id of existing) {
    if (id !== GLOBAL_SCOPE && !id.startsWith(USER_PREFIX)) continue;
    const path = join(root, id);
    const user = userMap.get(id);
    out.push({
      id,
      label: id === GLOBAL_SCOPE ? "Global" : user?.name || user?.email || userIdFromScope(id) || id,
      kind: id === GLOBAL_SCOPE ? "global" : "user",
      path,
      modified: await modifiedMs(path),
    });
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "global" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return out;
}

export async function listLogYears(scope: string): Promise<LogFolder[]> {
  const dir = scopeDir(scope);
  await ensureInsideLogs(dir).catch(() => mkdir(dir, { recursive: true }));
  return readSubdirs(dir, true);
}

export async function listLogMonths(scope: string, year: string): Promise<LogFolder[]> {
  const dir = join(scopeDir(scope), safeYear(year));
  await ensureInsideLogs(dir).catch(() => mkdir(dir, { recursive: true }));
  return readSubdirs(dir, true);
}

export async function listLogFiles(scope: string, year: string, month: string): Promise<LogFile[]> {
  const dir = scopedMonthDir(scope, year, month);
  await ensureInsideLogs(dir).catch(() => mkdir(dir, { recursive: true }));
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: LogFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".log")) continue;
      const path = join(dir, entry.name);
      const meta = await stat(path);
      out.push({ name: entry.name, path, size: meta.size, modified: meta.mtimeMs });
    }
    out.sort((a, b) => b.modified - a.modified);
    return out;
  } catch {
    return [];
  }
}

export async function readLogFile(
  scope: string,
  year: string,
  month: string,
  file: string,
): Promise<LogFileSnapshot> {
  const path = await ensureInsideLogs(logFilePath(scope, year, month, file));
  const meta = await stat(path);
  const start = Math.max(0, meta.size - MAX_LOG_READ_BYTES);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolvePromise, reject) => {
    const reader = createReadStream(path, { start });
    reader.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    reader.on("error", reject);
    reader.on("end", resolvePromise);
  });
  return {
    content: Buffer.concat(chunks).toString("utf8"),
    size: meta.size,
    modified: meta.mtimeMs,
    truncated: start > 0,
  };
}

export async function deleteLogFile(scope: string, year: string, month: string, file: string): Promise<void> {
  const path = await ensureInsideLogs(logFilePath(scope, year, month, file));
  await rm(path, { force: true });
}

function quoteField(value: unknown): string {
  const s = String(value ?? "");
  if (/^[^\s"=]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${quoteField(value)}`)
    .join(" ");
}

async function appendScopedLog(scope: string, event: string, fields: Record<string, unknown>) {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const dir = join(scopeDir(scope), yyyy, mm);
  await mkdir(dir, { recursive: true });
  const line = `[${now.getTime()}] ${event} ${formatFields(fields)}\n`;
  await appendFile(join(dir, `${yyyy}-${mm}-${dd}-api.log`), line, "utf8");
}

export function writeAdminLog(event: string, fields: Record<string, unknown>, userId?: string | null) {
  void appendScopedLog(GLOBAL_SCOPE, event, fields).catch(() => {});
  if (userId) void appendScopedLog(userScope(userId), event, fields).catch(() => {});
}

export function installRequestLogHook(app: FastifyInstance) {
  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.raw.url ?? "";
    if (raw.startsWith("/api/admin/logs")) return;
    writeAdminLog(
      "http.request",
      {
        method: req.method,
        path: raw.split("?")[0],
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
        user_id: req.auth?.userId,
        superadmin: req.auth?.isSuperadmin,
        ip: req.ip,
      },
      req.auth?.userId,
    );
  });
}
