import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { Client } from "ssh2";
import { env } from "../env.js";
import { db } from "../db/client.js";
import { buildHosts } from "../db/schema.js";
import { decryptString } from "../lib/crypto.js";

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: Buffer;
}

export interface ResolvedHost extends SshTarget {
  remoteBase: string;
  downloadsBase: string;
  downloadsBaseUrl: string;
  toolsPath: string | null;
  source: "db" | "env";
}

function readKey(inline: string | undefined, path: string | undefined): Buffer | null {
  const text = inline ? inline.replace(/\\n/g, "\n") : path ? readFileSync(path, "utf8") : null;
  return text ? Buffer.from(text, "utf8") : null;
}

async function dbHostFor(kind: "linux_docker" | "mac"): Promise<ResolvedHost | null> {
  const [row] = await db
    .select()
    .from(buildHosts)
    .where(and(eq(buildHosts.kind, kind), eq(buildHosts.online, true)))
    .limit(1);
  if (!row) return null;
  return {
    host: row.hostname,
    port: row.port,
    username: row.sshUser,
    privateKey: Buffer.from(decryptString(row.sshKeyEnc), "utf8"),
    remoteBase: row.remoteBase,
    downloadsBase: row.downloadsBase,
    downloadsBaseUrl: row.downloadsBaseUrl,
    toolsPath: row.toolsPath,
    source: "db",
  };
}

export async function resolveLinuxHost(): Promise<ResolvedHost | null> {
  const fromDb = await dbHostFor("linux_docker");
  if (fromDb) return fromDb;
  if (!env.LINUX_BUILD_HOST) return null;
  const key = readKey(env.LINUX_BUILD_SSH_KEY, env.LINUX_BUILD_SSH_KEY_PATH);
  if (!key) return null;
  return {
    host: env.LINUX_BUILD_HOST,
    port: env.LINUX_BUILD_PORT,
    username: env.LINUX_BUILD_USER,
    privateKey: key,
    remoteBase: env.LINUX_BUILD_REMOTE_BASE,
    downloadsBase: env.LINUX_BUILD_DOWNLOADS_BASE,
    downloadsBaseUrl: env.LINUX_BUILD_DOWNLOADS_BASE_URL,
    toolsPath: env.LINUX_BUILD_ANDROID_TOOLS,
    source: "env",
  };
}

export async function resolveMacHost(): Promise<ResolvedHost | null> {
  const fromDb = await dbHostFor("mac");
  if (fromDb) return fromDb;
  if (!env.MAC_BUILD_HOST || !env.MAC_BUILD_USER) return null;
  const key = readKey(env.MAC_BUILD_SSH_KEY, env.MAC_BUILD_SSH_KEY_PATH);
  if (!key) return null;
  return {
    host: env.MAC_BUILD_HOST,
    port: env.MAC_BUILD_PORT,
    username: env.MAC_BUILD_USER,
    privateKey: key,
    remoteBase: env.MAC_BUILD_REMOTE_BASE,
    downloadsBase: env.MAC_BUILD_DOWNLOADS_BASE,
    downloadsBaseUrl: env.MAC_BUILD_DOWNLOADS_BASE_URL,
    toolsPath: env.MAC_BUILD_TOOLS,
    source: "env",
  };
}

/** @deprecated kept for callers that haven't been migrated to resolveLinuxHost(). */
export function linuxSshTarget(): SshTarget | null {
  if (!env.LINUX_BUILD_HOST) return null;
  const key = readKey(env.LINUX_BUILD_SSH_KEY, env.LINUX_BUILD_SSH_KEY_PATH);
  if (!key) return null;
  return { host: env.LINUX_BUILD_HOST, port: env.LINUX_BUILD_PORT, username: env.LINUX_BUILD_USER, privateKey: key };
}
/** @deprecated kept for callers that haven't been migrated to resolveMacHost(). */
export function macSshTarget(): SshTarget | null {
  if (!env.MAC_BUILD_HOST || !env.MAC_BUILD_USER) return null;
  const key = readKey(env.MAC_BUILD_SSH_KEY, env.MAC_BUILD_SSH_KEY_PATH);
  if (!key) return null;
  return { host: env.MAC_BUILD_HOST, port: env.MAC_BUILD_PORT, username: env.MAC_BUILD_USER, privateKey: key };
}

function connect(target: SshTarget): Promise<Client> {
  const c = new Client();
  return new Promise((resolve, reject) => {
    c.once("ready", () => resolve(c));
    c.once("error", reject);
    c.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
    });
  });
}

export interface ExecResult {
  exitCode: number;
  signal: string | null;
}

/** Run a command, streaming stdout/stderr lines to `onLine`. Resolves with exit code. */
export function exec(
  client: Client,
  cmd: string,
  onLine: (line: string) => void | Promise<void>,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      let stdoutBuf = "";
      let stderrBuf = "";
      const flush = (buf: string, isErr: boolean): string => {
        const lines = buf.split(/\r?\n/);
        const tail = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) void onLine(isErr ? `! ${line}` : line);
        }
        return tail;
      };
      stream
        .on("data", (chunk: Buffer) => {
          stdoutBuf = flush(stdoutBuf + chunk.toString("utf8"), false);
        })
        .on("close", (code: number | null, signal: string | null) => {
          if (stdoutBuf) void onLine(stdoutBuf);
          if (stderrBuf) void onLine(`! ${stderrBuf}`);
          resolve({ exitCode: code ?? -1, signal });
        })
        .stderr.on("data", (chunk: Buffer) => {
          stderrBuf = flush(stderrBuf + chunk.toString("utf8"), true);
        });
    });
  });
}

/**
 * Open SSH, run the action, ensure the connection is closed.
 */
export async function withSsh<T>(target: SshTarget, action: (c: Client) => Promise<T>): Promise<T> {
  const client = await connect(target);
  try {
    return await action(client);
  } finally {
    client.end();
  }
}
