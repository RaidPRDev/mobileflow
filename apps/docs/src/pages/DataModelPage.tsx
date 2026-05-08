import { CodeBlock } from "@/components/CodeBlock";

export function DataModelPage() {
  return (
    <div>
      <h1>Data Model</h1>
      <p>
        MobileFlow uses Postgres with Drizzle ORM. The schema is organized around
        organizations, apps, builds, and billing.
      </p>

      <h2>Core entities</h2>

      <h3>organizations</h3>
      <CodeBlock
        code={`id uuid pk
name text
slug text unique
created_at timestamp
owner_user_id uuid -> users`}
        language="text"
      />

      <h3>users</h3>
      <CodeBlock
        code={`id uuid pk
email text unique
password_hash text
name text
avatar_url text
is_superadmin boolean default false`}
        language="text"
      />

      <h3>org_members</h3>
      <CodeBlock
        code={`org_id uuid -> organizations
user_id uuid -> users
role text — owner | admin | member
PK (org_id, user_id)`}
        language="text"
      />

      <h3>apps</h3>
      <CodeBlock
        code={`id char(8) pk
org_id uuid -> organizations
name text
icon_url text
runtime text — capacitor | cordova | react_native | ios_native | android_native
git_provider text — github | gitlab | bitbucket
git_repo_full_name text
git_default_branch text
created_at timestamp
deleted_at timestamp nullable`}
        language="text"
      />

      <h3>builds</h3>
      <CodeBlock
        code={`id uuid pk
app_id char(8) -> apps
commit_sha text
commit_message text
branch text
target text — ios | android | web
stack_id uuid -> build_stacks
build_type text — development | adhoc | appstore | debug | release
environment_id uuid nullable -> environments
status text — queued | running | success | failed | cancelled
host_id uuid nullable -> build_hosts
created_by uuid -> users
created_at timestamp
started_at timestamp nullable
finished_at timestamp nullable
artifacts jsonb
log_path text`}
        language="text"
      />

      <h3>build_steps</h3>
      <CodeBlock
        code={`id uuid pk
build_id uuid -> builds
name text
status text
started_at timestamp nullable
ended_at timestamp nullable
exit_code int nullable`}
        language="text"
      />

      <h2>URL conventions</h2>
      <p>
        App-scoped routes use the 8-character app ID for brevity:
      </p>
      <ul>
        <li><code>/org/:orgId/apps</code></li>
        <li><code>/app/:shortAppId/commits</code></li>
        <li><code>/app/:shortAppId/builds</code></li>
        <li><code>/app/:shortAppId/builds/:buildId</code></li>
        <li><code>/app/:shortAppId/deploy/destinations</code></li>
      </ul>
    </div>
  );
}
