import { defineConfig } from "drizzle-kit";
import { env } from "./src/env";

/**
 * Schema push config for the production container boot, which has no TTY.
 *
 * The default config (drizzle.config.ts) sets `strict: true`, which asks for
 * confirmation before every push — correct at a developer's keyboard, a hang at
 * container start. Here strict is off, so an additive change (new table, new
 * nullable column) applies unattended.
 *
 * drizzle-kit still prompts when a statement would drop data. With stdin closed
 * that prompt fails instead of hanging, the api task never goes healthy, and
 * Swarm rolls back to the previous image — which is the behaviour we want:
 * destructive schema changes get applied deliberately, by hand, against a
 * database that backup.prod.sh has just dumped.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: env.DATABASE_URL },
  strict: false,
  verbose: true,
});
