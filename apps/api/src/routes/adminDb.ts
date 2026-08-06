import type { FastifyInstance } from "fastify";
import { is, sql, type SQL } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { z } from "zod";
import JSZip from "jszip";
import { db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { requireSuperadmin } from "../auth/middleware.js";
import { writeAdminLog } from "../lib/adminLogs.js";

/**
 * Superadmin-only database browser, plus whole-database export/import.
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
 *     The one deliberate exception is the export/import pair at the bottom: a
 *     backup that dropped `password_hash` and every `*_enc` column would
 *     restore broken rows, so those endpoints move whole rows verbatim. The
 *     `*_enc` values are AES-256-GCM ciphertext that only decrypts under the
 *     same TOKEN_ENC_KEY, and the routes are superadmin-only and audit-logged.
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

// ─── Export / import ───────────────────────────────────────────────────────
//
// The export format is a single JSON document: { exportedAt, tables } where
// tables maps table name → array of raw rows. A "package" is a ZIP holding
// that same document as db.json — there is no separate media directory to
// bundle (logos, icons and cert blobs all live inside the database), so the
// package's only job is compression, which matters because the bytea/base64
// columns shrink ~4× under DEFLATE.

type Row = Record<string, unknown>;

interface DbSnapshot {
  exportedAt: string;
  tables: Record<string, Row[]>;
}

const PACKAGE_DB_ENTRY = "db.json";

// A full-database JSON body dwarfs the server-wide 10 MB bodyLimit; imports
// get their own generous per-route cap instead of raising the global one.
const IMPORT_BODY_LIMIT = 256 * 1024 * 1024;

/**
 * bytea values (postgres.js hands them over as Buffers) can't survive
 * JSON.stringify, so they're wrapped as { $bytea: "<base64>" } on the way out
 * and unwrapped by bindValue() on the way back in.
 */
const BYTEA_TAG = "$bytea";

function encodeRow(row: Row): Row {
  let out: Row | null = null;
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Uint8Array) {
      out ??= { ...row };
      out[key] = { [BYTEA_TAG]: Buffer.from(value).toString("base64") };
    }
  }
  return out ?? row;
}

/**
 * Binds a JSON-import value as a SQL parameter. Tagged bytea becomes a Buffer;
 * other objects/arrays become JSON text (the jsonb assignment target drives the
 * cast); everything else — including ISO date strings and uuids — binds as-is
 * and Postgres coerces from the column's type context.
 */
function bindValue(v: unknown): SQL {
  if (v === null || v === undefined) return sql`NULL`;
  if (typeof v === "object") {
    const tagged = v as Record<string, unknown>;
    if (typeof tagged[BYTEA_TAG] === "string" && Object.keys(tagged).length === 1) {
      return sql`${Buffer.from(tagged[BYTEA_TAG] as string, "base64")}`;
    }
    return sql`${JSON.stringify(v)}`;
  }
  return sql`${v as string | number | boolean}`;
}

/** Every registry table's full contents, sensitive columns included. */
async function snapshotTables(warn: (table: string, err: unknown) => void): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const name of [...REGISTRY.keys()].sort()) {
    try {
      const rows = (await db.execute(
        sql`SELECT * FROM ${sql.identifier(name)}`,
      )) as unknown as Row[];
      out[name] = rows.map(encodeRow);
    } catch (err) {
      // Declared in schema.ts but not pushed to this database yet.
      warn(name, err);
    }
  }
  return out;
}

/**
 * Parents before children so FK-ordered inserts resolve. Dependencies come
 * from the live database rather than the Drizzle schema — what's actually
 * enforced is what matters. Cycles (and self-references) are broken by
 * skipping back-edges; applyImport disables FK checks anyway, so the order is
 * belt-and-braces rather than load-bearing.
 */
async function fkInsertOrder(tables: string[]): Promise<string[]> {
  const deps = (await db.execute(sql`
    SELECT tc.table_name AS child, ccu.table_name AS parent
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
  `)) as unknown as { child: string; parent: string }[];
  const set = new Set(tables);
  const edges = new Map<string, Set<string>>();
  for (const t of tables) edges.set(t, new Set());
  for (const { child, parent } of deps) {
    if (child !== parent && set.has(child) && set.has(parent)) edges.get(child)!.add(parent);
  }
  const ordered: string[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (t: string) => {
    if (done.has(t) || visiting.has(t)) return;
    visiting.add(t);
    for (const p of edges.get(t)!) visit(p);
    visiting.delete(t);
    done.add(t);
    ordered.push(t);
  };
  for (const t of tables) visit(t);
  return ordered;
}

/**
 * Rule 1 applied to imports: every table must exist in the registry and every
 * row key must be a real column of that table before anything touches SQL.
 */
function validateImportTables(tables: Record<string, Row[]>): string | null {
  for (const [name, rows] of Object.entries(tables)) {
    const meta = REGISTRY.get(name);
    if (!meta) return `Unknown table in import: ${name}`;
    const cols = new Set(meta.columns.map((c) => c.name));
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!cols.has(key)) return `Unknown column "${key}" in table "${name}"`;
      }
    }
  }
  return null;
}

/**
 * Replace-all restore: one transaction that truncates every imported table and
 * refills it. FK enforcement is deferred for the transaction because rows are
 * inserted in arbitrary order *within* a table, so a self-referential FK would
 * fail even with tables topologically ordered; the snapshot comes from a
 * consistent source DB, so integrity already holds. SET LOCAL resets on
 * commit, and session_replication_role needs superuser — which the app's
 * Postgres role (the container's bootstrap user) is.
 */
async function applyImport(tables: Record<string, Row[]>): Promise<number> {
  const names = Object.keys(tables);
  if (names.length === 0) return 0;
  const order = await fkInsertOrder(names);
  let inserted = 0;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    const truncateList = sql.join(
      names.map((n) => sql`${sql.identifier(n)}`),
      sql`, `,
    );
    await tx.execute(sql`TRUNCATE TABLE ${truncateList} RESTART IDENTITY CASCADE`);

    for (const name of order) {
      for (const row of tables[name] ?? []) {
        const keys = Object.keys(row);
        if (keys.length === 0) continue;
        const colsSql = identList(keys);
        const valsSql = sql.join(keys.map((k) => bindValue(row[k])), sql`, `);
        await tx.execute(
          sql`INSERT INTO ${sql.identifier(name)} (${colsSql}) VALUES (${valsSql})`,
        );
        inserted++;
      }
    }
  });

  return inserted;
}

const ImportBody = z
  .object({
    tables: z.record(z.array(z.record(z.unknown()))),
  })
  .strict();

const ImportPackageBody = z
  .object({
    zipBase64: z.string().min(1),
  })
  .strict();

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

  // ─── Export: DB JSON ───────────────────────────────────────────────────────
  server.get("/admin/db/export", async (req, reply) => {
    const tables = await snapshotTables((table, err) =>
      server.log.warn({ err, table }, "admin db export skipped missing table"),
    );
    writeAdminLog(
      "admin_db.export",
      { tables: Object.keys(tables).length, rows: Object.values(tables).reduce((n, r) => n + r.length, 0) },
      req.auth?.userId,
    );
    reply.header("Content-Disposition", 'attachment; filename="mobileflow-db-export.json"');
    reply.header("Cache-Control", "no-store");
    const snapshot: DbSnapshot = { exportedAt: new Date().toISOString(), tables };
    return snapshot;
  });

  // ─── Export: package (ZIP of db.json) ──────────────────────────────────────
  server.get("/admin/db/export-package", async (req, reply) => {
    const tables = await snapshotTables((table, err) =>
      server.log.warn({ err, table }, "admin db export skipped missing table"),
    );
    const snapshot: DbSnapshot = { exportedAt: new Date().toISOString(), tables };
    const zip = new JSZip();
    zip.file(PACKAGE_DB_ENTRY, JSON.stringify(snapshot, null, 2));
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    writeAdminLog(
      "admin_db.export_package",
      { tables: Object.keys(tables).length, bytes: buffer.length },
      req.auth?.userId,
    );
    const stamp = snapshot.exportedAt.slice(0, 10);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="mobileflow-package-${stamp}.zip"`);
    reply.header("Cache-Control", "no-store");
    return reply.send(buffer);
  });

  // ─── Import: DB JSON ───────────────────────────────────────────────────────
  server.post("/admin/db/import", { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const parsed = ImportBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("Body must be { tables: { <table>: [rows] } }");
    const invalid = validateImportTables(parsed.data.tables as Record<string, Row[]>);
    if (invalid) return reply.badRequest(invalid);

    try {
      const inserted = await applyImport(parsed.data.tables as Record<string, Row[]>);
      writeAdminLog(
        "admin_db.import",
        { tables: Object.keys(parsed.data.tables).length, inserted },
        req.auth?.userId,
      );
      return { ok: true, inserted };
    } catch (err) {
      server.log.error({ err }, "admin db import failed");
      return reply.badRequest(errText(err));
    }
  });

  // ─── Import: package ───────────────────────────────────────────────────────
  server.post("/admin/db/import-package", { bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    const parsed = ImportPackageBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest("Body must be { zipBase64 }");

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(Buffer.from(parsed.data.zipBase64, "base64"));
    } catch {
      return reply.badRequest("Could not read this file as a ZIP package");
    }
    const dbEntry = zip.file(PACKAGE_DB_ENTRY);
    if (!dbEntry) return reply.badRequest(`Package is missing ${PACKAGE_DB_ENTRY}`);

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(await dbEntry.async("string"));
    } catch {
      return reply.badRequest(`${PACKAGE_DB_ENTRY} is not valid JSON`);
    }
    const body = ImportBody.safeParse(
      snapshot && typeof snapshot === "object" ? { tables: (snapshot as { tables?: unknown }).tables } : {},
    );
    if (!body.success) return reply.badRequest(`${PACKAGE_DB_ENTRY} is not a valid DB export`);
    const invalid = validateImportTables(body.data.tables as Record<string, Row[]>);
    if (invalid) return reply.badRequest(invalid);

    try {
      const inserted = await applyImport(body.data.tables as Record<string, Row[]>);
      writeAdminLog(
        "admin_db.import_package",
        { tables: Object.keys(body.data.tables).length, inserted },
        req.auth?.userId,
      );
      return { ok: true, inserted };
    } catch (err) {
      server.log.error({ err }, "admin db package import failed");
      return reply.badRequest(errText(err));
    }
  });
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return "Database error";
}
