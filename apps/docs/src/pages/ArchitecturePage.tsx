import { CodeBlock } from "@/components/CodeBlock";

export function ArchitecturePage() {
  return (
    <div>
      <h1>Architecture</h1>
      <p>
        MobileFlow is a monorepo split into apps, packages, and infrastructure.
        The frontend is a React SPA served by RSPack. The backend is a Fastify
        API with Postgres. Builds are orchestrated by a worker that delegates to
        Docker and SSH runners.
      </p>

      <h2>Repository layout</h2>
      <CodeBlock
        code={`apps/
  web/          # React + RSPack + LESS — the UI
  desktop/      # Tauri shell wrapping apps/web
  api/          # Node (Fastify) — REST + WebSocket
  worker/       # Build orchestrator — pulls jobs, drives SSH/Docker
packages/
  ui/           # Shared React components, theme tokens
  shared/       # TS types, zod schemas, shared utils
infra/
  docker/       # Dockerfiles for api, worker, builders
  migrations/   # Postgres migrations`}
        language="text"
      />

      <h2>Frontend stack</h2>
      <ul>
        <li>React 18 with TypeScript</li>
        <li>RSPack for bundling and dev server</li>
        <li>React Router for SPA routing</li>
        <li>Zustand for client state</li>
        <li>TanStack Query for server state</li>
        <li>Tailwind CSS + CSS variables for theming</li>
        <li>shadcn/ui primitives wrapped in @mobileflow/ui</li>
      </ul>

      <h2>Backend stack</h2>
      <ul>
        <li>Fastify with TypeScript</li>
        <li>Postgres 16 with Drizzle ORM</li>
        <li>pg-boss for job queue (deferred; currently in-process polling)</li>
        <li>WebSocket via @fastify/websocket for live build logs</li>
        <li>Argon2 for password hashing</li>
        <li>AES-256-GCM for secret encryption</li>
      </ul>

      <h2>Build hosts</h2>
      <ul>
        <li>
          <strong>Linux Docker host</strong>: Android and Web builds via
          parameterized Docker images.
        </li>
        <li>
          <strong>Mac VM(s)</strong>: iOS builds via SSH with key-based auth.
          Each host is registered in the database with capacity and capabilities.
        </li>
      </ul>

      <h2>Auth model</h2>
      <p>
        Users can authenticate via email and password or SSO (Google/GitHub). A
        user can belong to multiple organizations via <code>org_members</code>{" "}
        with roles owner, admin, or member. Apps belong to an organization and
        are referenced by an 8-character hex ID in URLs.
      </p>

      <h2>Data model highlights</h2>
      <p>Key tables and their responsibilities:</p>
      <ul>
        <li>
          <code>organizations</code> — billing isolation unit; owns apps,
          members, and subscriptions.
        </li>
        <li>
          <code>apps</code> — runtime, git provider, repo, and branch.
        </li>
        <li>
          <code>git_connections</code> — OAuth tokens per org and provider.
        </li>
        <li>
          <code>builds</code> — commit, target, stack, status, and artifact
          metadata.
        </li>
        <li>
          <code>build_steps</code> — per-step status and timing for pipeline
          visualization.
        </li>
        <li>
          <code>certificates</code> — encrypted signing materials per org and
          platform.
        </li>
        <li>
          <code>store_destinations</code> — App Store Connect and Google Play
          configuration.
        </li>
        <li>
          <code>subscriptions</code> — Stripe-backed plan state per org.
        </li>
      </ul>
    </div>
  );
}
