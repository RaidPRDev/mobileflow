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

      <h2>4. Push the database schema</h2>
      <CodeBlock code="pnpm db:push" language="bash" />

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
