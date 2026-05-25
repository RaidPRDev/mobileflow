import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";

// Conservative security headers applied to every response. We hand-roll this
// instead of pulling @fastify/helmet so we (a) avoid an extra dep, (b) keep
// the policy explicit and grep-able from one file. The set mirrors helmet's
// defaults with two project-specific tweaks:
//
//   1. HSTS is only emitted in production. In dev, the API runs on http://
//      and HSTS would force-upgrade subsequent http requests to https and
//      break the local SPA.
//
//   2. CSP is intentionally restrictive ("default-src 'none'") because the
//      API serves JSON only — no HTML, no inline assets. The SPA at
//      WEB_BASE_URL is a separate origin with its own (looser) CSP.
export async function securityHeaders(_req: FastifyRequest, reply: FastifyReply) {
  // Block MIME sniffing.
  reply.header("X-Content-Type-Options", "nosniff");
  // Refuse to be framed — the API has no UI, so any framing attempt is hostile.
  reply.header("X-Frame-Options", "DENY");
  // Modern equivalent of X-Frame-Options for embeds; also covers <object>/<embed>.
  reply.header("Cross-Origin-Resource-Policy", "same-site");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  // Tell browsers not to leak the referring URL on cross-origin navigations.
  reply.header("Referrer-Policy", "no-referrer");
  // Disable Flash/Acrobat cross-domain policies that we'd never want to honour.
  reply.header("X-Permitted-Cross-Domain-Policies", "none");
  // Per OWASP — the legacy XSS filter does more harm than good; turn it off.
  reply.header("X-XSS-Protection", "0");
  reply.header("X-DNS-Prefetch-Control", "off");
  reply.header("Origin-Agent-Cluster", "?1");
  // JSON-only API; nothing should ever execute, fetch, or render here.
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  if (env.isProd) {
    // 6 months, include subdomains. We don't preload by default — that's a
    // one-way commitment that should be made deliberately, not by middleware.
    reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}
