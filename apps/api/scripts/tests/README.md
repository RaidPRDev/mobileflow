# Security integration tests

Standalone Node scripts that boot the API in-process (via `app.inject()`)
and exercise the security hardening added under tasks #1–#10.

## Prerequisites

- A running Postgres reachable at `DATABASE_URL` (see `.env`)
- The schema must be up to date: run `pnpm db:push` from `apps/api` first
- `tsx` is available (`apps/api` already lists it as a dev dependency)

These scripts import TypeScript directly via `tsx`. Run them through `tsx`:

```bash
cd apps/api
pnpm exec tsx scripts/tests/run-all.mts
```

Or invoke an individual file:

```bash
pnpm exec tsx scripts/tests/rateLimit.test.mts
```

## What's covered

| File | Verifies |
| ---- | -------- |
| `rateLimit.test.mts` | `/auth/login` returns 429 after N hits per IP and per email; rate-limit reset on successful login |
| `captcha.test.mts` | After 3 failures the email requires a captcha; correct code lets you in; wrong code does not; consumed codes can't be replayed |
| `signupEnum.test.mts` | Duplicate-email signup returns the same generic 200 as a new signup (no 409, no "in use") |
| `csrf.test.mts` | Cookie-auth POST without `X-CSRF-Token` is 403; bearer-auth POST is allowed; safe methods bypass |
| `securityHeaders.test.mts` | Every response carries CSP, X-Content-Type-Options, X-Frame-Options, etc. |
| `deviceTokenExpiry.test.mts` | A token past `expiresAt` is rejected; a token whose `lastUsedAt` exceeds the idle window is rejected |
| `envBoot.test.mts` | Spawning the API with `COOKIE_SECRET` < 32 chars exits non-zero; `TRUST_PROXY=true` in prod exits non-zero |
| `trustProxy.test.mts` | When `TRUST_PROXY=false`, `X-Forwarded-For` is ignored for `req.ip` |
| `run-all.mts` | Runs every `*.test.mts` and reports pass/fail counts |

Tests use unique email prefixes per file (`rl-`, `cap-`, `enum-`, etc.) and
clean up the rows they create. They are safe to run repeatedly against a
shared dev DB.
