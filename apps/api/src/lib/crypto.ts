import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env.js";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  if (!env.TOKEN_ENC_KEY) {
    throw new Error("TOKEN_ENC_KEY is not configured (need 32 bytes hex). Set it before storing OAuth tokens.");
  }
  return Buffer.from(env.TOKEN_ENC_KEY, "hex");
}

export function encryptString(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptString(packed: string): string {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
