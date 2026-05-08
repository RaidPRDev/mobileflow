import { hash, verify } from "@node-rs/argon2";

const OPTS = {
  memoryCost: 19_456, // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export function verifyPassword(stored: string, plain: string): Promise<boolean> {
  return verify(stored, plain);
}
