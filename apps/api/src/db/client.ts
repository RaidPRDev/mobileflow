import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env.js";
import * as schema from "./schema.js";

const queryClient = postgres(env.DATABASE_URL, {
  max: env.isProd ? 20 : 5,
  prepare: false,
});

export const db = drizzle(queryClient, { schema });
export type Db = typeof db;
