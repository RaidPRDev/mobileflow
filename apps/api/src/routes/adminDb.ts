import type { FastifyInstance } from "fastify";
import { is, sql, type SQL } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { requireSuperadmin } from "../auth/middleware.js";
import { writeAdminLog } from "../lib/adminLogs.js";

/**
 * Superadmin-only database browser.
 *
 * Two rules shape the whole file:
 *
 *  1. **Identifiers never come from the client.** Every table and column name
 *     is looked up in a registry derived from the Drizzle schema at boot, so a
 *     request can only ever name something that already exists in code. The
 *     names are then emitted through `sql.identifier()` (quoted), and all
 *     values through bound parameters. There is no path from request data into
 *     raw SQL text.
 *
 *  2. **Secrets are never read.** Columns whose names look like credentials
 *     (`*_enc`, `password_hash`, `*_token`, …) are excluded from the SELECT
 *     list entirely rather than fetched and masked on the way out — the values
 *     don't reach this process, let alone the browser. They're also rejected as
 *     update targets, so this page can't be used to rewrite a token either.
 *
 * DDL is deliberately absent: no create/alter/drop, and no free-form SQL.
 */

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

// Matches column names that hold credentials or key material. Deliberately
// broad — a false positive only means the column shows as "hidden" in the UI,
// while a false negative would put a secret on the wire.
const SENSITIVE_COLUMN = /(password|passwd|secret|token|_enc$|_hash$|hash$|private_?key|credential)/i;

interface ColumnMeta {
  name: string;
  dataType: string;
  notNull: boolean;
  hasDefault: boolean;
  isPrimaryKey: boolean;
  /** Excluded from reads and blocked as an update target. */
  sensitive: boolean;
}

interface TableMeta {
  name: string;
  columns: ColumnMeta[];
  primaryKey: string[];
  /** Columns safe to read — i.e. everything but `sensitive`. */
  readable: string[];
}

function buildRegistry(): Map<string, TableMeta> {
  const out = new Map<string, TableMeta>();
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    const pk = new Set<string>();
    for (const col of cfg.columns) if (col.primary) pk.add(col.name);
    for (const composite of cfg.primaryKeys) {
      for (const col of composite.columns) pk.add(col.name);
    }
    const columns: ColumnMeta[] = cfg.columns.map((col) => ({
      name: col.name,
      dataType: col.getSQLType(),
      notNull: col.notNull,
      hasDefault: col.hasDefault,
      isPrimaryKey: pk.has(col.name),
      sensitive: SENSITIVE_COLUMN.test(col.name),
    }));
    out.set(cfg.name, {
      name: cfg.name,
      columns,
      primaryKey: [...pk],
      readable: columns.filter((c) => !c.sensitive).map((c) => c.name),
    });
  }
  return out;
}

// Built once at import: the schema can't change at runtime, and this doubles as
// the allow-list every request is checked against.
const REGISTRY = buildRegistry();

/** Columns worth showing first, and the default sort when a table has one. */
const PREFERRED_SORT = ["created_at", "createdAt", "started_at", "id"];

function tableOr404(name: string): TableMeta | null {
  return REGISTRY.get(name) ?? null;
}

function identList(names: string[]): SQL {
  return sql.join(
    names.map((n) => sql.identifier(n)),
    sql`, `,
  );
}

/** `WHERE pk_a = $1 AND pk_b = $2` from a validated pk map. */
function pkPredicate(meta: TableMeta, pk: Record<string, unknown>): SQL {
  return sql.join(
    meta.primaryKey.map((col) => sql`${sql.identifier(col)} = ${pk[col]}`),
    sql` AND `,
  );
}

/**
 * Validates a caller-supplied primary key against the table's real key.
 * Every key column must be present, and nothing else may be.
 */
function parsePk(meta: TableMeta, raw: unknown): { ok: true; pk: Record<string, unknown> } | { ok: false; error: string } {
  if (meta.primaryKey.length === 0) {
    return { ok: false, error: `Table "${meta.name}" has no primary key — rows can't be addressed individually` };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "pk must be an object of primary-key columns" };
  }
  const input = raw as Record<string, unknown>;
  const pk: Record<string, unknown> = {};
  for (const col of meta.primaryKey) {
    const v = input[col];
    if (v === undefined || v === null) return { ok: false, error: `pk.${col} is required` };
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
      return { ok: false, error: `pk.${col} must be a scalar` };
    }
    pk[col] = v;
  }
  for (const key of Object.keys(input)) {
    if (!meta.primaryKey.includes(key)) return { ok: false, error: `pk.${key} is not part of the primary key` };
  }
  return { ok: true, pk };
}

const RowsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).default(0),
  orderBy: z.string().max(120).optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
  q: z.string().max(200).optional(),
});

export async function adminDbRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireSuperadmin);

  // ─── Table list ────────────────────────────────────────────────────────────
  // Row counts are exact `count(*)`. These tables are small (an admin install,
  // not an analytics warehouse) and an approximate count from pg_class is 0 for
  // anything never vacuumed, which reads as "empty" and is worse than slow.
  server.get("/admin/db/tables", async () => {
    const names = [...REGISTRY.keys()].sort();
    const counts = await Promise.all(
      names.map(async (name) => {
        try {
          const rows = (await db.execute<{ count: number }>(
            sql`SELECT count(*)::int AS count FROM ${sql.identifier(name)}`,
          )) as unknown as { count: number }[];
          return rows[0]?.count ?? 0;
        } catch (err) {
          // A table declared in schema.ts but not yet pushed to this database.
          server.log.warn({ err, table: name }, "admin db count failed");
          return null;
        }
      }),
    );
    return names.map((name, i) => {
      const meta = REGISTRY.get(name)!;
      return {
        name,
        rowCount: counts[i],
        columnCount: meta.columns.length,
        hiddenColumnCount: meta.columns.filter((c) => c.sensitive).length,
        primaryKey: meta.primaryKey,
      };
    });
  });

  // ─── Rows ──────────────────────────────────────────────────────────────────
  server.get<{ Params: { table: string } }>("/admin/db/tables/:table/rows", async (req, reply) => {
    const meta = tableOr404(req.params.table);
    if (!meta) return reply.notFound("Unknown table");
    const parsed = RowsQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.issues[0]?.message ?? "Bad query");
    const { limit, offset, dir, q } = parsed.data;

    if (meta.readable.length === 0) {
      return reply.badRequest(`Every column on "${meta.name}" is sensitive — nothing to show`);
    }

    // Sort column: caller's choice if it's real and readable, else the first
    // preferred column present, else the first readable column.
    let orderBy = parsed.data.orderBy;
    if (orderBy && !meta.readable.includes(orderBy)) {
      return reply.badRequest(`Cannot sort by "${orderBy}"`);
    }
    if (!orderBy) {
      orderBy = PREFERRED_SORT.find((c) => meta.readable.includes(c)) ?? meta.readable[0]!;
    }

    // Free-text search: cast each readable column to text and ILIKE it. Cheap
    // and index-less, which is fine at admin-table scale and means the caller
    // doesn't have to know column types.
    let where: SQL = sql`TRUE`;
    if (q && q.trim()) {
      const needle = `%${q.trim()}%`;
      where = sql`(${sql.join(
        meta.readable.map((c) => sql`${sql.identifier(c)}::text ILIKE ${needle}`),
        sql` OR `,
      )})`;
    }

    try {
      const rows = (await db.execute(
        sql`SELECT ${identList(meta.readable)} FROM ${sql.identifier(meta.name)}
            WHERE ${where}
            ORDER BY ${sql.identifier(orderBy)} ${dir === "asc" ? sql`ASC` : sql`DESC`}
            LIMIT ${limit} OFFSET ${offset}`,
      )) as unknown as Record<string, unknown>[];
      const totalRows = (await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM ${sql.identifier(meta.name)} WHERE ${where}`,
      )) as unknown as { count: number }[];
      return {
        table: meta.name,
        columns: meta.columns,
        primaryKey: meta.primaryKey,
        rows,
        total: totalRows[0]?.count ?? 0,
        limit,
        offset,
        orderBy,
        dir,
      };
    } catch (err) {
      server.log.error({ err, table: meta.name }, "admin db rows failed");
      return reply.badRequest(errText(err));
    }
  });

  // ─── Update a row ──────────────────────────────────────────────────────────
  server.patch<{ Params: { table: string }; Body: { pk?: unknown; values?: unknown } }>(
    "/admin/db/tables/:table/rows",
    async (req, reply) => {
      const meta = tableOr404(req.params.table);
      if (!meta) return reply.notFound("Unknown table");
      const key = parsePk(meta, req.body?.pk);
      if (!key.ok) return reply.badRequest(key.error);

      const rawValues = req.body?.values;
      if (rawValues == null || typeof rawValues !== "object" || Array.isArray(rawValues)) {
        return reply.badRequest("values must be an object");
      }
      const values = rawValues as Record<string, unknown>;
      const assignments: SQL[] = [];
      for (const [col, value] of Object.entries(values)) {
        const colMeta = meta.columns.find((c) => c.name === col);
        if (!colMeta) return reply.badRequest(`Unknown column "${col}"`);
        if (colMeta.sensitive) return reply.badRequest(`Column "${col}" is protected and can't be edited here`);
        // Primary keys are identity, not data: rewriting one silently detaches
        // every row that references it (FKs here are mostly ON DELETE, not
        // ON UPDATE CASCADE). Delete + recreate instead.
        if (colMeta.isPrimaryKey) return reply.badRequest(`Column "${col}" is part of the primary key and can't be edited`);
        if (value !== null && typeof value === "object") {
          // jsonb columns: hand Postgres the serialized form and let the
          // assignment target drive the cast.
          assignments.push(sql`${sql.identifier(col)} = ${JSON.stringify(value)}`);
        } else {
          assignments.push(sql`${sql.identifier(col)} = ${value}`);
        }
      }
      if (assignments.length === 0) return reply.badRequest("No columns to update");

      try {
        const updated = (await db.execute(
          sql`UPDATE ${sql.identifier(meta.name)}
              SET ${sql.join(assignments, sql`, `)}
              WHERE ${pkPredicate(meta, key.pk)}
              RETURNING ${identList(meta.readable)}`,
        )) as unknown as Record<string, unknown>[];
        if (updated.length === 0) return reply.notFound("Row not found");
        writeAdminLog(
          "admin_db.row_updated",
          { table: meta.name, pk: JSON.stringify(key.pk), columns: Object.keys(values).join(",") },
          req.auth?.userId,
        );
        return { row: updated[0] };
      } catch (err) {
        server.log.error({ err, table: meta.name }, "admin db update failed");
        return reply.badRequest(errText(err));
      }
    },
  );

  // ─── Delete a row ──────────────────────────────────────────────────────────
  server.delete<{ Params: { table: string }; Body: { pk?: unknown } }>(
    "/admin/db/tables/:table/rows",
    async (req, reply) => {
      const meta = tableOr404(req.params.table);
      if (!meta) return reply.notFound("Unknown table");
      const key = parsePk(meta, req.body?.pk);
      if (!key.ok) return reply.badRequest(key.error);

      // Locking yourself out of the admin area with one click isn't a recovery
      // path anybody wants; the row is reachable via SQL if it's truly needed.
      if (meta.name === "users" && key.pk["id"] === req.auth?.userId) {
        return reply.badRequest("You can't delete your own user row");
      }

      try {
        const deleted = (await db.execute(
          sql`DELETE FROM ${sql.identifier(meta.name)} WHERE ${pkPredicate(meta, key.pk)} RETURNING ${identList(meta.readable)}`,
        )) as unknown as Record<string, unknown>[];
        if (deleted.length === 0) return reply.notFound("Row not found");
        writeAdminLog(
          "admin_db.row_deleted",
          { table: meta.name, pk: JSON.stringify(key.pk) },
          req.auth?.userId,
        );
        return { deleted: deleted.length };
      } catch (err) {
        // Most failures here are FK violations — surface the DB's own message,
        // it names the offending constraint and is more useful than ours.
        server.log.error({ err, table: meta.name }, "admin db delete failed");
        return reply.badRequest(errText(err));
      }
    },
  );
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return "Database error";
}
