import { posix as posixPath } from "node:path";

/**
 * Strip any directory components from a user-supplied filename, then verify
 * the result is a usable non-traversal basename. Throws on input that can't
 * be safely materialized as a leaf file on disk.
 *
 * The upload route (`apps/api/src/routes/certificates.ts`) already rejects
 * unsafe filenames before they reach the DB, so in normal operation this
 * function returns its input unchanged. The hardening here is for legacy
 * rows that pre-date the validator: certificates uploaded before the
 * tightening could still hold path-traversal payloads in `fileName`. The
 * runner reads those rows and concatenates them into `${certsDir}/...`
 * paths on the build host, so we re-sanitize at the point of use.
 *
 * Examples:
 *   safeBasename("MyCert.p12")             → "MyCert.p12"
 *   safeBasename("../../etc/passwd")       → "passwd"     (then rejected: ok)
 *   safeBasename("foo/../bar.p12")         → "bar.p12"
 *   safeBasename("..")                     → throws
 *   safeBasename(".")                      → throws
 *   safeBasename("")                       → throws
 *   safeBasename("foo<NUL>.p12")          → throws
 */
export function safeBasename(input: string, fieldLabel = "fileName"): string {
  // Strip both POSIX and Windows-style directory parts. We normalize backslashes
  // to forward slashes first because path.posix.basename treats backslashes as
  // ordinary characters; without this, a legacy filename like "a\\b.p12" would
  // pass through unchanged.
  const normalized = input.replace(/\\/g, "/");
  const base = posixPath.basename(normalized);
  if (!base || base === "." || base === "..") {
    throw new Error(`${fieldLabel} is not a valid filename`);
  }
  if (/[\x00-\x1f\x7f]/.test(base)) {
    throw new Error(`${fieldLabel} must not contain control characters`);
  }
  if (base.startsWith(".")) {
    throw new Error(`${fieldLabel} must not start with a dot`);
  }
  return base;
}
