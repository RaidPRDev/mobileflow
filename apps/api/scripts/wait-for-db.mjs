#!/usr/bin/env node
/**
 * Block until Postgres accepts a query, then exit 0.
 *
 * Swarm ignores `depends_on`, so the api task regularly starts while the db
 * task is still initializing. Without this, the boot chain's very first step
 * (the schema push) would fail on connection-refused and the container would
 * crash-loop until Postgres happened to win the race.
 *
 * A TCP probe is not enough: Postgres opens its socket before it finishes
 * recovery and while it is still in "the database system is starting up", so we
 * actually run `select 1`.
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("wait-for-db: DATABASE_URL is not set");
  process.exit(1);
}

const TIMEOUT_MS = Number(process.env.WAIT_FOR_DB_TIMEOUT_MS ?? 120_000);
const INTERVAL_MS = 2_000;
const deadline = Date.now() + TIMEOUT_MS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let attempt = 0;
for (;;) {
  attempt += 1;
  // A fresh client per attempt: the driver caches a failed connection's state,
  // and one connection with no retry logic of its own is easier to reason about
  // than fighting the pool's.
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
    await sql.end({ timeout: 5 });
    console.log(`wait-for-db: Postgres is ready (attempt ${attempt})`);
    process.exit(0);
  } catch (err) {
    await sql.end({ timeout: 5 }).catch(() => {});
    if (Date.now() >= deadline) {
      console.error(
        `wait-for-db: giving up after ${attempt} attempts / ${Math.round(TIMEOUT_MS / 1000)}s — ${err.message}`,
      );
      process.exit(1);
    }
    console.log(`wait-for-db: not ready yet (${err.code ?? err.message}), retrying…`);
    await sleep(INTERVAL_MS);
  }
}
