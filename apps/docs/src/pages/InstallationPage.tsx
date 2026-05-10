import { CodeBlock } from "@/components/CodeBlock";

export function InstallationPage() {
  return (
    <div>
      <h1>Installation</h1>
      <p>
        MobileFlow is a pnpm monorepo. The following steps will get the web app,
        API, and database running on your local machine.
      </p>

      <h2>Prerequisites</h2>
      <ul>
        <li>Node.js 20+</li>
        <li>pnpm 8.15.6+</li>
        <li>Docker (for local Postgres)</li>
      </ul>

      <h2>1. Clone the repository</h2>
      <CodeBlock
        code={`git clone <repository-url> mobileflow
cd mobileflow`}
        language="bash"
      />

      <h2>2. Install dependencies</h2>
      <CodeBlock code="pnpm install" language="bash" />

      <h2>3. Start the local database</h2>
      <CodeBlock code="pnpm dev:db" language="bash" />
      <p>
        This spins up a Postgres container using the development compose file at{" "}
        <code>infra/.docker/dev.yml</code>.
      </p>
      <p>
        To stop the container, run <code>pnpm dev:db:down</code>. To wipe the
        database volume and start fresh — useful when the schema has drifted or
        seed data is in a bad state — run:
      </p>
      <CodeBlock code="pnpm dev:db:reset" language="bash" />
      <p>
        This tears the container down with <code>-v</code> (removing the volume,
        which deletes all data) and brings it back up empty. Re-run{" "}
        <code>pnpm db:push</code> and <code>pnpm db:seed</code> afterward to
        restore the schema and baseline data.
      </p>

      <h2>4. Push the database schema</h2>
      <CodeBlock code="pnpm db:push" language="bash" />
      <p>
        This is a thin wrapper around <code>drizzle-kit push</code> running
        inside <code>apps/api</code>. It reads the Drizzle schema at{" "}
        <code>apps/api/src/db/schema.ts</code> and the config at{" "}
        <code>apps/api/drizzle.config.ts</code>, then applies the diff directly
        to the Postgres instance referenced by <code>DATABASE_URL</code> — no
        migration files are generated.
      </p>
      <p>
        Because <code>strict</code> and <code>verbose</code> are enabled in the
        Drizzle config, the CLI prints every statement it intends to run and
        prompts before executing destructive changes (dropping columns, tables,
        or indexes). Re-run this command any time you edit{" "}
        <code>schema.ts</code> to bring your local database in sync.
      </p>
      <p>
        <strong>Note:</strong> <code>db:push</code> is intended for local
        development only. For staging and production, generate proper migration
        files with <code>drizzle-kit generate</code> and apply them via{" "}
        <code>drizzle-kit migrate</code> so schema changes are reviewable and
        reproducible.
      </p>

      <h2>5. Seed the database</h2>
      <CodeBlock code="pnpm db:seed" language="bash" />
      <p>
        The seeder creates the default subscription plans and an initial superadmin
        account if <code>SUPERADMIN_EMAIL</code> is configured.
      </p>

      <h2>6. Run the API</h2>
      <CodeBlock code="pnpm dev:api" language="bash" />
      <p>
        The API starts on <code>http://127.0.0.1:4000</code> by default.
      </p>

      <h2>7. Run the web app</h2>
      <CodeBlock code="pnpm dev" language="bash" />
      <p>
        The dev server starts on <code>http://127.0.0.1:5173</code> and proxies{" "}
        <code>/api</code> requests to the backend.
      </p>

      <h2>Environment variables</h2>
      <p>
        Create an <code>.env</code> file in <code>apps/api</code> with at least the
        following:
      </p>
      <CodeBlock
        code={`DATABASE_URL=postgres://user:pass@localhost:5432/mobileflow
SESSION_SECRET=your-session-secret
SUPERADMIN_EMAIL=admin@example.com

# SSO (optional for local dev)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Stripe (optional for local dev)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=`}
        language="bash"
      />

      <h2>Desktop development</h2>
      <p>
        To run the Tauri desktop shell alongside the web dev server:
      </p>
      <CodeBlock code="pnpm --filter @mobileflow/desktop dev" language="bash" />
    </div>
  );
}
