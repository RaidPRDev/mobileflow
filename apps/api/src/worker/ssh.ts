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
  /**
   * A best-effort tail of the command output (stdout and stderr interleaved as
   * seen). Used by callers to surface a meaningful error message when the
   * command exits non-zero — without this the only failure signal is the bash
   * wrapping ("command failed (exit 1): bash -lc ..."), which buries the real
   * cause (e.g. an Xcode signing error or a Transporter upload rejection) in
   * the streamed logs.
   */
  outputTail: string;
}

// Keep the last ~3KB of output lines for the tail. Plenty for a typical error
// stanza, small enough to fit in the build row's errorMessage column.
const TAIL_BUDGET = 3000;

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
      const tailLines: string[] = [];
      let tailSize = 0;
      const pushTail = (line: string) => {
        tailLines.push(line);
        tailSize += line.length + 1;
        while (tailSize > TAIL_BUDGET && tailLines.length > 1) {
          tailSize -= (tailLines.shift()!.length + 1);
        }
      };
      const flush = (buf: string, isErr: boolean): string => {
        const lines = buf.split(/\r?\n/);
        const tail = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) {
            pushTail(isErr ? `! ${line}` : line);
            void onLine(isErr ? `! ${line}` : line);
          }
        }
        return tail;
      };
      stream
        .on("data", (chunk: Buffer) => {
          stdoutBuf = flush(stdoutBuf + chunk.toString("utf8"), false);
        })
        .on("close", (code: number | null, signal: string | null) => {
          if (stdoutBuf) {
            pushTail(stdoutBuf);
            void onLine(stdoutBuf);
          }
          if (stderrBuf) {
            pushTail(`! ${stderrBuf}`);
            void onLine(`! ${stderrBuf}`);
          }
          resolve({ exitCode: code ?? -1, signal, outputTail: tailLines.join("\n") });
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

/**
 * ssh.exec() that always drains stdout+stderr and enforces a timeout. Plain
 * `ssh.exec` with only a "close" listener can hang if the channel has buffered
 * output nobody is reading — bit us once in the iOS pipeline and once in the
 * Android keystore upload.
 */
export function execDrained(ssh: Client, cmd: string, label: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    ssh.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stderrBuf = "";
      stream.on("data", () => {}); // drain stdout
      stream.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf8"); });
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        reject(new Error(`${label} failed (exit ${code}): ${stderrBuf.trim().slice(0, 300) || "(no stderr)"}`));
      });
      stream.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    });
  });
}

/**
 * Upload a base64-encoded blob to a remote file by piping it into
 * `base64 -d` (Linux) or `base64 -D` (macOS). Drains stdout/stderr and
 * enforces a timeout — same hang risk as execDrained. The parent
 * directory must already exist; the caller is expected to mkdir.
 */
export function uploadBase64(
  ssh: Client,
  opts: { base64: string; remotePath: string; label: string; decoder: "linux" | "mac"; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const flag = opts.decoder === "mac" ? "-D" : "-d";
  const dest = `'${opts.remotePath.replace(/'/g, `'\\''`)}'`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`upload ${opts.label} timed out after ${timeoutMs}ms`)), timeoutMs);
    ssh.exec(`base64 ${flag} > ${dest}`, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stderrBuf = "";
      stream.on("data", () => {}); // drain stdout
      stream.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf8"); });
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        reject(new Error(`upload ${opts.label} failed (exit ${code}): ${stderrBuf.trim().slice(0, 300) || "(no stderr)"}`));
      });
      stream.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
      stream.write(opts.base64);
      stream.end();
    });
  });
}
