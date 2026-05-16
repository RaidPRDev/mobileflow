import type { FastifyInstance } from "fastify";
import { asc } from "drizzle-orm";
import { db } from "../db/client.js";
import { buildStacks } from "../db/schema.js";
import { requireUser } from "../auth/middleware.js";

// Public (auth-required) read of the stacks catalog. Used by the new-build
// flow to populate the platform/stack picker and by the build detail page to
// resolve a stack id to a human label. Admin write endpoints live on
// /admin/stacks in `admin.ts`.
export async function stackRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get("/stacks", async () => {
    const rows = await db
      .select()
      .from(buildStacks)
      .orderBy(asc(buildStacks.platform), asc(buildStacks.sortOrder), asc(buildStacks.label));
    return rows;
  });
}
