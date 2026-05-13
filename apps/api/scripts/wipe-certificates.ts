// One-shot data wipe required for the per-app signing certificates migration.
// Run before `pnpm db:push` so drizzle can swap org_id → app_id (NOT NULL) on
// an empty table. Existing certificates and their builds.certificate_id refs
// are intentionally dropped — they were org-scoped and have to be re-uploaded
// against an app.
//
// Usage:  pnpm --filter @mobileflow/api exec tsx scripts/wipe-certificates.ts
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

async function main() {
  const cleared = await db.execute(
    sql`UPDATE builds SET certificate_id = NULL WHERE certificate_id IS NOT NULL`,
  );
  const deleted = await db.execute(sql`DELETE FROM certificates`);
  // postgres-js returns the raw command tag on .count; log both for visibility.
  console.log(`Cleared builds.certificate_id on ${cleared.count ?? 0} rows`);
  console.log(`Deleted ${deleted.count ?? 0} certificates`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
