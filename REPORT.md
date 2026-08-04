# MobileFlow Code Review Report

## Executive Summary

MobileFlow is a **high-quality codebase with strong security fundamentals**. The project demonstrates careful engineering across authentication, authorization, database operations, and command execution. Security essentials are in place: parameterized queries (Drizzle ORM), Argon2id hashing, CSRF protection, shell escaping, AES-256-GCM encryption, and restrictive security headers.

**Findings: 1 High + 5 Medium + 7 Low severity issues.** No critical vulnerabilities. Most issues are timing attacks, race conditions, and configuration concerns rather than exploitable flaws.

---

## Critical Issues
**None found.**

---

## High Severity

### H1 — SVG Logo Enables Stored XSS Against Admins
**Location:** `apps/api/src/routes/admin.ts` (`PUT/GET /admin/company-info/logo`)

**Issue:** The logo endpoint accepts `image/svg+xml` and serves it raw with `Content-Type: image/svg+xml` without `Content-Disposition: attachment`. SVG files can embed `<script>` tags and event handlers, allowing stored XSS when an admin views the logo.

**Context:** The codebase deliberately excludes SVG from app icons and avatars for this exact reason (see comments in `apps.ts` and `auth.ts`). The logo path is inconsistent with this security policy.

**Mitigations in place:** API CSP header `default-src 'none'` provides partial protection by blocking inline scripts when SVG is the document root in modern browsers. However, CSP coverage for inline SVG is not universal, and the PDF renderer (pdfkit) consuming the blob doesn't handle SVG anyway.

**Fix:**
- Remove `image/svg+xml` from `LOGO_MIMES` and rasterize SVGs to PNG client-side (matching icon/avatar handling), OR
- Serve the response with `Content-Disposition: attachment` and an explicit CSP header

**Priority:** Fix immediately.

---

## Medium Severity

### M1 — Login Timing Oracle Enables User Enumeration
**Location:** `apps/api/src/routes/auth.ts` (`POST /auth/login`)

**Issue:** Signup carefully pads responses to a 500ms floor and burns CPU on the duplicate-email path to prevent timing attacks. Login does not: an unknown email returns immediately after `recordFailedAttempt`, while a known email runs expensive `verifyPassword` (Argon2, ~50–150ms). Attackers can enumerate registered emails by measuring response times despite the uniform "Invalid credentials" message.

**Fix:** Run a dummy `verifyPassword` against a constant fake hash when `!user || !user.passwordHash` to equalize the cost:
```typescript
if (!user) {
  // Dummy verify to burn time on unknown user
  await verifyPassword(password, "$2y$12$...dummy...");
  return { ok: false };
}
```

**Priority:** High — matches signup's existing hardening model.

---

### M2 — Signup Has Race Condition on Duplicate Email
**Location:** `apps/api/src/routes/auth.ts` (signup handler)

**Issue:** Two concurrent signups for the same new email both pass the `SELECT` check, then race to `INSERT`. The second insert hits Postgres unique constraint `23505` and throws an unhandled error → `500 InternalServerError`. A 500 vs normal `{ok:true}` is itself an enumeration signal.

**Context:** The `/me` PATCH path already handles `23505` gracefully; signup should too.

**Fix:** Wrap the insert in try/catch and return the same padded `{ok:true}` response:
```typescript
try {
  await db.insert(users).values({...});
} catch (err) {
  if (err.code === '23505') return { ok: true }; // Unique constraint
  throw err;
}
```

**Priority:** High — addresses the race condition the codebase already recognizes in other paths.

---

### M3 — `apps.transfer` Adds Caller to Wrong Organization
**Location:** `apps/api/src/routes/apps.ts` (`POST /apps/:appId/transfer`)

**Issue:** After validating the transfer, the code does:
```typescript
await db.insert(orgMembers).values({ 
  orgId: row.orgId,  // ← This is the SOURCE org, not target
  userId: req.auth.userId, 
  role: "member" 
})
```

A user transferring an app out of their org gets added as a `member` back into the source org—an unintended standing access and a membership record pollution.

**Fix:** Confirm the intended behavior (retain access in source, or grant access in target?), then use the correct `orgId` (likely `targetOrgId`), or remove entirely.

**Priority:** Medium — likely a logic bug affecting access control.

---

### M4 — In-Memory Rate Limiter Defeated by Horizontal Scaling
**Location:** `apps/api/src/lib/rateLimit.ts`, `apps/api/src/auth/loginAttempts.ts`

**Issue:** Brute-force protections split between two backends:
- `loginAttempts`: DB-backed, shared across instances ✓
- Per-IP/per-email `consume()`: process-local `Map` ✗

With multiple API instances behind a load balancer, the per-request rate-limit caps multiply by instance count and purges are per-process. The code comment acknowledges this is only safe for single-process. This is a latent regression the moment the service scales.

**Fix:**
- Confirm single-instance deployment is enforced in infra, OR
- Move rate-limit buckets to a shared store (Redis) before scaling, OR
- Add a comment warning about scaling and an env assertion if multi-instance is ever supported

**Priority:** Medium — escalates to High if multi-instance deployment is planned.

---

### M5 — Dead Code: Redundant Constant-Time Compare on Device Tokens
**Location:** `apps/api/src/auth/deviceToken.ts` (`resolveDeviceToken`)

**Issue:** The database query `WHERE tokenHash = <computed hash>` ensures `row.tokenHash === tokenHash` is always true if a row is found. The subsequent `timingSafeEqual(a, b)` always passes and provides no timing protection.

The actual timing characteristic is the indexed DB lookup on `tokenHash`, which is not constant-time but is acceptable because the input is a SHA-256 of a 256-bit secret (not feasibly enumerable).

**Impact:** Not exploitable, but the dead comparison invites false confidence.

**Fix:** Remove the redundant comparison, or add a comment explaining why it's present (e.g., "input is already high-entropy").

**Priority:** Low — code quality/clarity, not a security issue.

---

## Low Severity

### L1 — CSRF Cookie `sameSite: "lax"` Assumes Same-Site Deployment
**Location:** `apps/api/src/routes/auth.ts` (session cookie), `apps/api/src/auth/csrf.ts`

**Issue:** The SPA and API can be on different origins (default: `:5173` vs `:4000`). With `sameSite: "lax"`, credentialed XHR from SPA to API origin still sends cookies. The double-submit CSRF design and restricted CORS compensate, so this works in the documented same-site setup. But if API and web ever move to different registrable domains, cross-site cookie-sending could break auth.

**Fix:** Add a comment and assertion tying `WEB_ORIGINS`/`API_BASE_URL` to the same registrable domain.

**Priority:** Low — defensive documentation.

---

### L2 — Duplicated Superadmin Auth in WebSocket Terminal
**Location:** `apps/api/src/routes/admin.ts` (terminal route)

**Issue:** The admin terminal route re-implements session resolution and superadmin validation inline because `@fastify/websocket` bypasses preHandlers. The logic is correct but duplicated from `middleware.ts`, creating a drift risk if one copy is updated without the other.

**Fix:** Extract a shared `resolveSuperadminFromCookie(req)` helper and use it in both places.

**Priority:** Low — code organization.

---

### L3 — Manual `.env` Parsing Silently Truncates Multiline Values
**Location:** `apps/api/src/env.ts` (`loadDotEnv`)

**Issue:** Hand-rolled `.env` parsing skips lines without `=`, strips one layer of matching quotes, but doesn't handle escaped quotes, multiline values, or `export` prefixes. A multiline SSH key placed directly in `.env` (rather than a `_PATH` file) would be silently truncated at the first newline with no warning.

**Fix:** Document that secrets with newlines must use the `\n`-escaped single-line form (which `readKey` expects) or a file path. Consider using a mature `.env` parser library if robustness is needed.

**Priority:** Low — operational documentation.

---

### L4 — `auth/login/needs-captcha` Is Unauthenticated and Unthrottled
**Location:** `apps/api/src/routes/auth.ts` (`GET /auth/login/needs-captcha`)

**Issue:** The endpoint only returns a boolean and threshold (no existence leak), but it issues an unthrottled `count(*)` query per call. This is a cheap amplification vector for database load. A bot can repeatedly query this endpoint to measure DB performance degradation.

**Fix:** Add a light per-IP rate limit consistent with other auth endpoints.

**Priority:** Low — defense in depth.

---

### L5 — Captcha SVG Glyphs Not Escaped
**Location:** `apps/api/src/auth/captcha.ts` (`renderSvg`)

**Issue:** Captcha glyphs are interpolated into SVG strings:
```typescript
const ch = ALPHABET[i]; // A-Z, 2-9 (safe today)
// ... then directly into SVG text
```

Today's alphabet is safe, but the string-building is not injection-proof. If the alphabet ever gains `&`, `<`, `>` characters, it produces malformed or injectable SVG.

**Fix:** XML-escape `ch` to make the function safe by construction.

**Priority:** Low — future-proofing.

---

### L6 — Lazy Cleanup Purges Not Verified as Scheduled
**Location:** `apps/api/src/session.ts`, `captcha.ts`, `loginAttempts.ts`

**Issue:** Purge helpers exist (`purgeExpiredSessions`, `purgeExpiredCaptchas`) but I didn't see them scheduled in a worker. `loginAttempts` has no purge at all and grows unbounded (rows only deleted on successful login per email).

**Fix:** Confirm `maintenance.ts` or a scheduled worker actually invokes the purge functions on a regular schedule. Add a periodic prune for `loginAttempts` older than the 15-minute brute-force window.

**Priority:** Low — operational reliability.

---

### L7 — Sequential Organization Deletion Is N Round-Trips
**Location:** `apps/api/src/routes/auth.ts` (account deletion), `apps/api/src/routes/admin.ts` (admin user delete)

**Issue:** Deleting user-owned organizations loops one `DELETE` per org outside a transaction:
```typescript
for (const org of orgs) {
  await db.delete(organizations).where(...);
}
```

For a user owning several orgs, this is N round-trips and not atomic — a failure midway leaves a partially deleted account.

**Fix:** Wrap in a transaction and/or use batch delete with `inArray`:
```typescript
await db.delete(organizations).where(inArray(organizations.id, ids));
```

**Priority:** Low — performance and atomicity.

---

## Positive Findings

- **Authorization is consistent:** Every data route resolves the resource and enforces `requireOrgMember(orgId)` with superadmin bypass. Uses `reply.notFound()` to avoid existence leaks. Excellent pattern.
- **Remote command escaping is thorough:** All bash interpolation goes through `shq`/`shqMac` escaping, with additional `safeBasename` re-validation at point-of-use as defense-in-depth.
- **Webhook security is isolated:** Stripe/processor webhooks use a separate scope with raw-body parsing and adapter-side signature verification, correctly bypassing CSRF.
- **Log access is hardened:** Admin logs validate every path segment with regexes **and** `realpath`-confirm the resolved path stays under the logs root. Strong.
- **Frontend XSS surface is minimal:** No `dangerouslySetInnerHTML`; data flows through React text nodes. Icon/avatar schemas reject SVG (consistent policy to maintain).

---

## Recommended Fix Priority

1. **H1 (SVG Logo)** — Remove SVG support or serve with `Content-Disposition: attachment`. Close a stored XSS door.
2. **M1 + M2 (Login Timing + Signup Race)** — Finish the enumeration hardening that signup already models. Both are quick wins.
3. **M3 (Transfer Membership)** — Verify intended behavior; likely a real access-control bug.
4. **M4 (Rate-Limit Scaling)** — Document or move to Redis before scaling horizontally.

---

## Summary Table

| ID   | Severity | Category                    | Status       |
|------|----------|----------------------------|--------------|
| H1   | High     | Security (XSS)              | Needs fix    |
| M1   | Medium   | Security (Timing)           | Needs fix    |
| M2   | Medium   | Security (Race)             | Needs fix    |
| M3   | Medium   | Logic (Authorization)       | Needs fix    |
| M4   | Medium   | Operational (Scaling)       | Needs action |
| M5   | Medium   | Quality (Dead code)         | Cleanup     |
| L1   | Low      | Documentation (CSRF)        | Doc only    |
| L2   | Low      | Code organization           | Cleanup     |
| L3   | Low      | Documentation (.env)        | Doc only    |
| L4   | Low      | Security (DDoS)             | Nice-to-have |
| L5   | Low      | Security (Future-proofing)  | Nice-to-have |
| L6   | Low      | Operational (Maintenance)   | Verify      |
| L7   | Low      | Performance (Atomicity)     | Cleanup     |

---

## Notes for Follow-Up

- The codebase is notably well-engineered. The issues identified are mostly edge cases, timing attacks, and operational concerns—not fundamental design flaws.
- Security practices are mature: constant-time comparisons, double-submit CSRF, privilege-based authorization, and careful escaping.
- The team should maintain the policy of rejecting SVG in user-controlled content (currently enforced for icons/avatars; extend to logo).
- Before scaling to multiple API instances, ensure rate-limiting moves to a shared backend (Redis) or enforce single-instance in infra.

