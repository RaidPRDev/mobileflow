import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Label,
  cn,
  Loading,
} from "@mobileflow/ui";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Database,
  Download,
  Eye,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  ApiError,
  api,
  type AdminDbColumn,
  type AdminDbRows,
} from "../api/client";
import { ListFooter } from "../components/ListFooter";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";

const PAGE_SIZE = 25;

// ─── Export / import progress ────────────────────────────────────────────────

type StepStatus = "pending" | "active" | "done" | "error";

interface ProgressStep {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

interface ProgressState {
  title: string;
  steps: ProgressStep[];
  finished: boolean;
  error: string | null;
  /** Imports truncate `sessions`, so the Done button reloads the page. */
  reloadOnDone?: boolean;
}

const IMPORT_RELOAD_NOTE =
  "The database was replaced, so your current sign-in may no longer be valid. " +
  "The page will reload when you click Done — sign in again if prompted.";

const ENC_KEY_NOTE =
  "Encrypted columns (git tokens, certificates, processor credentials) only decrypt if this " +
  "server uses the same TOKEN_ENC_KEY as the export's source.";

export function AdminDatabasePage() {
  const qc = useQueryClient();
  const [table, setTable] = useState<string | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [orderBy, setOrderBy] = useState<string | undefined>(undefined);
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [viewing, setViewing] = useState<Record<string, unknown> | null>(null);
  const [deleting, setDeleting] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Column the pointer is over in the header row — highlights the whole column
  // beneath it, so a value can be traced back to its heading on wide tables.
  const [hoverCol, setHoverCol] = useState<string | null>(null);

  const tablesQ = useQuery({
    queryKey: ["admin-db-tables"],
    queryFn: () => api.admin.dbTables(),
  });

  const rowsQ = useQuery({
    queryKey: ["admin-db-rows", table, page, search, orderBy, dir],
    queryFn: () =>
      api.admin.dbRows(table!, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        orderBy,
        dir,
        q: search.trim() || undefined,
      }),
    enabled: !!table,
    placeholderData: keepPreviousData,
  });

  // Switching tables resets everything derived from the old one — a sort column
  // from the previous table would 400 against the new one.
  const selectTable = (name: string) => {
    setTable(name);
    setPage(0);
    setSearch("");
    setOrderBy(undefined);
    setDir("desc");
    setError(null);
  };

  const visibleTables = useMemo(() => {
    const q = tableFilter.trim().toLowerCase();
    const list = tablesQ.data ?? [];
    return q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list;
  }, [tablesQ.data, tableFilter]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["admin-db-rows"] });
    void qc.invalidateQueries({ queryKey: ["admin-db-tables"] });
  };

  // A warm refetch can settle in a few milliseconds, so driving the icon off
  // `isFetching` alone often never paints and the click looks like it did
  // nothing. Hold the spin for one full 900ms turn (the length of `admin-spin`,
  // so it stops square at 360°) and let `isFetching` carry it further when the
  // query is genuinely slow.
  const [spinning, setSpinning] = useState(false);
  const spinTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (spinTimer.current !== null) window.clearTimeout(spinTimer.current);
    },
    [],
  );

  const refreshRows = () => {
    setSpinning(true);
    if (spinTimer.current !== null) window.clearTimeout(spinTimer.current);
    spinTimer.current = window.setTimeout(() => setSpinning(false), 900);
    void qc.invalidateQueries({ queryKey: ["admin-db-rows"] });
  };

  const update = useMutation({
    mutationFn: ({ pk, values }: { pk: Record<string, unknown>; values: Record<string, unknown> }) =>
      api.admin.dbUpdateRow(table!, pk, values),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not update row"),
  });

  const remove = useMutation({
    mutationFn: (pk: Record<string, unknown>) => api.admin.dbDeleteRow(table!, pk),
    onSuccess: () => {
      setDeleting(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not delete row"),
  });

  // ─── Export / import ───────────────────────────────────────────────────────

  const jsonFileRef = useRef<HTMLInputElement>(null);
  const packageFileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [importJson, setImportJson] = useState<Record<string, Record<string, unknown>[]> | null>(null);
  const [importPackageFile, setImportPackageFile] = useState<File | null>(null);

  const patchStep = (key: string, patch: Partial<ProgressStep>) =>
    setProgress((p) => p && { ...p, steps: p.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
  const finishOk = () => setProgress((p) => p && { ...p, finished: true });
  const failRun = (message: string) =>
    setProgress(
      (p) =>
        p && {
          ...p,
          finished: true,
          error: message,
          steps: p.steps.map((s) => (s.status === "active" ? { ...s, status: "error" as const } : s)),
        },
    );

  async function runExportJson() {
    setProgress({
      title: "Export database (JSON)",
      finished: false,
      error: null,
      steps: [
        { key: "fetch", label: "Fetching database snapshot", status: "active" },
        { key: "build", label: "Building JSON file", status: "pending" },
        { key: "save", label: "Saving file", status: "pending" },
      ],
    });
    try {
      const data = await api.admin.dbExport();
      const tableCount = Object.keys(data.tables).length;
      const rowCount = Object.values(data.tables).reduce((n, r) => n + r.length, 0);
      patchStep("fetch", { status: "done", detail: `${tableCount} tables · ${rowCount.toLocaleString()} rows` });
      patchStep("build", { status: "active" });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      patchStep("build", { status: "done", detail: formatBytes(blob.size) });
      patchStep("save", { status: "active" });
      downloadBlob(blob, `mobileflow-db-${data.exportedAt.slice(0, 10)}.json`);
      patchStep("save", { status: "done" });
      finishOk();
    } catch (e) {
      failRun(e instanceof ApiError ? e.message : "Export failed");
    }
  }

  async function runExportPackage() {
    setProgress({
      title: "Export package",
      finished: false,
      error: null,
      steps: [
        { key: "build", label: "Building package on the server", status: "active" },
        { key: "save", label: "Saving archive", status: "pending" },
      ],
    });
    try {
      const blob = await api.admin.dbExportPackage();
      patchStep("build", { status: "done", detail: formatBytes(blob.size) });
      patchStep("save", { status: "active" });
      downloadBlob(blob, `mobileflow-package-${new Date().toISOString().slice(0, 10)}.zip`);
      patchStep("save", { status: "done" });
      finishOk();
    } catch (e) {
      failRun(e instanceof ApiError ? e.message : "Export failed");
    }
  }

  const onJsonFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setError(null);
    file
      .text()
      .then((txt) => {
        const parsed = JSON.parse(txt) as { tables?: unknown };
        const tables = parsed && typeof parsed === "object" ? parsed.tables : null;
        if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
          throw new Error("Not a valid export file");
        }
        setImportJson(tables as Record<string, Record<string, unknown>[]>);
      })
      .catch(() => setError("Could not read this file as a database export"));
  };

  const onPackageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setImportPackageFile(file);
  };

  async function runImportJson() {
    if (!importJson) return;
    const tables = importJson;
    setImportJson(null);
    const tableCount = Object.keys(tables).length;
    const rowCount = Object.values(tables).reduce((n, r) => n + r.length, 0);
    setProgress({
      title: "Import database (JSON)",
      finished: false,
      error: null,
      reloadOnDone: true,
      steps: [
        {
          key: "read",
          label: "Read import file",
          status: "done",
          detail: `${tableCount} tables · ${rowCount.toLocaleString()} rows`,
        },
        { key: "restore", label: "Replacing database", status: "active" },
      ],
    });
    try {
      const res = await api.admin.dbImport(tables);
      patchStep("restore", { status: "done", detail: `${res.inserted.toLocaleString()} rows restored` });
      invalidate();
      finishOk();
    } catch (e) {
      failRun(e instanceof ApiError ? e.message : "Import failed");
    }
  }

  async function runImportPackage() {
    if (!importPackageFile) return;
    const file = importPackageFile;
    setImportPackageFile(null);
    setProgress({
      title: "Import package",
      finished: false,
      error: null,
      reloadOnDone: true,
      steps: [
        { key: "read", label: "Reading package file", status: "active", detail: formatBytes(file.size) },
        { key: "restore", label: "Uploading & replacing database", status: "pending" },
      ],
    });
    try {
      const zipBase64 = await fileToBase64(file);
      patchStep("read", { status: "done" });
      patchStep("restore", { status: "active" });
      const res = await api.admin.dbImportPackage(zipBase64);
      patchStep("restore", { status: "done", detail: `${res.inserted.toLocaleString()} rows restored` });
      invalidate();
      finishOk();
    } catch (e) {
      failRun(e instanceof ApiError ? e.message : "Package import failed");
    }
  }

  const data = rowsQ.data;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const grid = useDragScroll<HTMLDivElement>();

  return (
    <div className="page admin-db-page">
      <div className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">Database</h1>
          <p className="text-help">
            Every table in the schema. Credential columns are never read from the database, so they
            can't be viewed or edited here.
          </p>
        </div>
        <div className="page-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Download size={14} aria-hidden />
                Export
                <ChevronDown size={14} aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void runExportJson()}>Export DB JSON</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void runExportPackage()}>Export Package</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Upload size={14} aria-hidden />
                Import
                <ChevronDown size={14} aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => jsonFileRef.current?.click()}>Import DB JSON</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => packageFileRef.current?.click()}>Import Package</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={jsonFileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={onJsonFile}
          />
          <input
            ref={packageFileRef}
            type="file"
            accept="application/zip,.zip"
            hidden
            onChange={onPackageFile}
          />
        </div>
      </div>

      {error && <p className="text-error">{error}</p>}

      <div className="admin-db-browser">
        {/* ─── Table list ─────────────────────────────────────────────────── */}
        <aside className="admin-db-browser__sidebar">
          <div className="admin-db-browser__sidebar-head">
            <div className="admin-db-search">
              <Search size={14} className="admin-db-search__icon" aria-hidden />
              <input
                className="admin-db-search__input"
                placeholder="Find a table…"
                value={tableFilter}
                onChange={(e) => setTableFilter(e.target.value)}
                aria-label="Find a table"
              />
              {tableFilter && (
                <button
                  type="button"
                  className="admin-db-search__clear"
                  aria-label="Clear"
                  onClick={() => setTableFilter("")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          <nav className="admin-db-browser__tables app-scroll">
            {tablesQ.isLoading && (
              <div className="builds-status">
                <Loading>Loading tables…</Loading>
              </div>
            )}
            {tablesQ.error && (
              <div className="builds-status is-error">{(tablesQ.error as ApiError).message}</div>
            )}
            {visibleTables.map((t) => (
              <button
                key={t.name}
                type="button"
                className={cn("admin-db-table-item", table === t.name && "is-active")}
                onClick={() => selectTable(t.name)}
              >
                <Database size={14} aria-hidden />
                <span className="admin-db-table-item__name">{t.name}</span>
                <span className="admin-db-table-item__count">
                  {t.rowCount == null ? "—" : t.rowCount.toLocaleString()}
                </span>
              </button>
            ))}
            {!tablesQ.isLoading && visibleTables.length === 0 && (
              <div className="builds-status">No tables match “{tableFilter}”.</div>
            )}
          </nav>
        </aside>

        {/* ─── Rows ───────────────────────────────────────────────────────── */}
        <section className="admin-db-browser__main">
          {!table && (
            <div className="empty-state" style={{ margin: "auto" }}>
              <div className="empty-state__title">Pick a table</div>
              <p className="text-help">Choose a table on the left to browse its rows.</p>
            </div>
          )}

          {table && (
            <>
              <div className="admin-db-toolbar">
                {/* Row count lives in the footer (`ListFooter total unit="row"`),
                    so the toolbar carries only the table name. */}
                <div className="admin-db-toolbar__title">
                  <code className="plan-card__id">{table}</code>
                </div>
                <div className="admin-db-search admin-db-search--toolbar">
                  <Search size={14} className="admin-db-search__icon" aria-hidden />
                  <input
                    className="admin-db-search__input"
                    placeholder="Search all columns…"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(0);
                    }}
                    aria-label="Search rows"
                  />
                </div>
                <IconButton aria-label="Refresh" onClick={refreshRows}>
                  <RefreshCw
                    size={14}
                    className={cn((spinning || rowsQ.isFetching) && "is-spinning")}
                  />
                </IconButton>
              </div>

              {rowsQ.isLoading && (
                <div className="builds-status">
                  <Loading>Loading rows…</Loading>
                </div>
              )}
              {rowsQ.error && (
                <div className="builds-status is-error">{(rowsQ.error as ApiError).message}</div>
              )}

              {data && (
                <>
                  <div
                    ref={grid.ref}
                    className={cn("admin-db-grid-scroll app-scroll", grid.dragging && "is-dragging")}
                    onPointerDown={grid.onPointerDown}
                  >
                    <table className="admin-db-grid">
                      <thead>
                        <tr>
                          {data.columns.map((c) => (
                            <th
                              key={c.name}
                              scope="col"
                              className={cn(hoverCol === c.name && "is-col-hover")}
                              onMouseEnter={() => setHoverCol(c.name)}
                              onMouseLeave={() => setHoverCol((h) => (h === c.name ? null : h))}
                            >
                              <button
                                type="button"
                                className="admin-db-grid__sort"
                                disabled={c.sensitive}
                                onClick={() => {
                                  if (c.sensitive) return;
                                  if (orderBy === c.name) {
                                    setDir(dir === "asc" ? "desc" : "asc");
                                  } else {
                                    setOrderBy(c.name);
                                    setDir("asc");
                                  }
                                  setPage(0);
                                }}
                              >
                                <span className="admin-db-grid__sort-name">{c.name}</span>
                                {data.orderBy === c.name ? (
                                  data.dir === "asc" ? (
                                    <ArrowUp size={11} aria-hidden />
                                  ) : (
                                    <ArrowDown size={11} aria-hidden />
                                  )
                                ) : (
                                  // Ghost arrow: hidden until the header is hovered,
                                  // where it previews what a click will do. Always
                                  // rendered so the label never shifts sideways.
                                  !c.sensitive && (
                                    <ArrowUp size={11} className="admin-db-grid__sort-hint" aria-hidden />
                                  )
                                )}
                              </button>
                            </th>
                          ))}
                          <th
                            scope="col"
                            className="admin-db-grid__actions-head"
                            aria-label="Actions"
                          />
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((row, i) => (
                          <tr key={rowKeyOf(data, row, i)}>
                            {data.columns.map((c) => (
                              <td
                                key={c.name}
                                className={cn(
                                  c.sensitive && "is-hidden-col",
                                  hoverCol === c.name && "is-col-hover",
                                )}
                              >
                                <Cell column={c} value={row[c.name]} />
                              </td>
                            ))}
                            <td className="admin-db-grid__actions">
                              {/* Inner flex row: the cell itself stays a table-cell
                                  so it can stick to the right edge while the rest
                                  of the grid scrolls under it. */}
                              <div className="admin-db-grid__actions-inner">
                                <IconButton aria-label="View row" onClick={() => setViewing(row)}>
                                  <Eye size={13} />
                                </IconButton>
                                <IconButton
                                  aria-label="Edit row"
                                  disabled={data.primaryKey.length === 0}
                                  onClick={() => {
                                    setError(null);
                                    setEditing(row);
                                  }}
                                >
                                  <Pencil size={13} />
                                </IconButton>
                                <IconButton
                                  aria-label="Delete row"
                                  disabled={data.primaryKey.length === 0}
                                  onClick={() => {
                                    setError(null);
                                    setDeleting(row);
                                  }}
                                >
                                  <Trash2 size={13} />
                                </IconButton>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {data.rows.length === 0 && (
                          <tr>
                            <td colSpan={data.columns.length + 1} className="admin-db-grid__empty">
                              {search ? `No rows match “${search}”.` : "This table is empty."}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="admin-db-browser__footer">
                    <ListFooter
                      pageIdx={page}
                      pageCount={pageCount}
                      total={data.total}
                      unit="row"
                      busy={rowsQ.isFetching}
                      onPrev={() => setPage((p) => Math.max(0, p - 1))}
                      onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                      onPage={setPage}
                    />
                    {data.primaryKey.length === 0 && (
                      <p className="text-help">
                        This table has no primary key, so individual rows can't be edited or deleted
                        here.
                      </p>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>

      {viewing && data && (
        <RowViewDialog columns={data.columns} row={viewing} onClose={() => setViewing(null)} />
      )}

      {editing && data && (
        <RowEditDialog
          table={data.table}
          columns={data.columns}
          primaryKey={data.primaryKey}
          row={editing}
          busy={update.isPending}
          onCancel={() => setEditing(null)}
          onSave={(values) => {
            const pk = pkOf(data.primaryKey, editing);
            update.mutate({ pk, values });
          }}
        />
      )}

      {deleting && data && (
        <ConfirmDeleteDialog
          title={`Delete row from ${data.table}`}
          itemName={describePk(pkOf(data.primaryKey, deleting))}
          details={[
            "Rows referencing this one may be deleted too, depending on the foreign key.",
            "There is no undo, and no backup is taken first.",
          ]}
          confirmLabel="Delete row"
          error={remove.error}
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(pkOf(data.primaryKey, deleting))}
        />
      )}

      {importJson && (
        <ImportConfirmDialog
          title="Import database (JSON)"
          confirmLabel="Replace data"
          onCancel={() => setImportJson(null)}
          onConfirm={() => void runImportJson()}
        >
          <p>
            <strong>
              {Object.values(importJson)
                .reduce((n, r) => n + r.length, 0)
                .toLocaleString()}{" "}
              rows
            </strong>{" "}
            across <strong>{Object.keys(importJson).length} tables</strong> will be restored.
            Existing rows in those tables are deleted first. This cannot be undone.
          </p>
          <p className="text-help">{ENC_KEY_NOTE}</p>
        </ImportConfirmDialog>
      )}

      {importPackageFile && (
        <ImportConfirmDialog
          title="Import package"
          confirmLabel="Replace everything"
          onCancel={() => setImportPackageFile(null)}
          onConfirm={() => void runImportPackage()}
        >
          <p>
            <strong>{importPackageFile.name}</strong> will replace every table in the database.
            Existing data is deleted first. This cannot be undone.
          </p>
          <p className="text-help">{ENC_KEY_NOTE}</p>
        </ImportConfirmDialog>
      )}

      {progress && <ProgressDialog state={progress} onClose={() => setProgress(null)} />}
    </div>
  );
}

// ─── Export / import dialogs ─────────────────────────────────────────────────

function ImportConfirmDialog({
  title,
  confirmLabel,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProgressDialog({ state, onClose }: { state: ProgressState; onClose: () => void }) {
  // Reload only on a clean finish: after an error the DB may be half-replaced,
  // and closing without reloading would leave the UI showing pre-import data.
  const reload = state.finished && !state.error && !!state.reloadOnDone;
  const dismissable = state.finished && !reload;
  return (
    <Dialog open onOpenChange={(o) => !o && dismissable && onClose()}>
      <DialogContent
        className="admin-db-dialog"
        aria-describedby={undefined}
        hideCloseButton={!dismissable}
        onEscapeKeyDown={(e) => {
          if (!dismissable) e.preventDefault();
        }}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{state.title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <ul className="admin-db-progress">
            {state.steps.map((s) => (
              <li key={s.key} className={cn("admin-db-progress__step", `is-${s.status}`)}>
                <span className="admin-db-progress__icon" aria-hidden>
                  {s.status === "done" && <Check size={13} />}
                  {s.status === "error" && <X size={13} />}
                  {s.status === "active" && <Loader2 size={13} className="is-spinning" />}
                </span>
                <span className="admin-db-progress__label">{s.label}</span>
                {s.detail && <span className="admin-db-progress__detail">{s.detail}</span>}
              </li>
            ))}
          </ul>
          {state.error && <p className="text-error">{state.error}</p>}
          {state.reloadOnDone && !state.error && <p className="text-help">{IMPORT_RELOAD_NOTE}</p>}
        </DialogBody>
        {state.finished && (
          <DialogFooter>
            <Button onClick={() => (reload ? window.location.reload() : onClose())}>Done</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Grid panning ────────────────────────────────────────────────────────────

/**
 * Grab-and-pan the row grid: most tables are far wider than the pane, so
 * dragging anywhere in it scrolls like a touch swipe instead of selecting text.
 * Returns the ref for the scroll container plus its pointerdown handler.
 */
function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent<T>) => {
    const el = ref.current;
    // Left button only; touch already scrolls natively, and interactive cells
    // (the view/edit/delete buttons) must keep their normal click behaviour.
    if (!el || e.button !== 0 || e.pointerType === "touch") return;
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = el.scrollLeft;
    const startTop = el.scrollTop;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Small threshold so a plain click isn't treated as a drag.
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      setDragging(true);
      el.scrollLeft = startLeft - dx;
      el.scrollTop = startTop - dy;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return { ref, dragging, onPointerDown };
}

// ─── Cells ───────────────────────────────────────────────────────────────────

/**
 * Hard cap on the text put in the DOM. The cell is clipped visually by CSS
 * (one line, ellipsis), so this only keeps multi-kilobyte values — log text,
 * JSON blobs — out of the document; the full value goes in the tooltip.
 */
const CELL_MAX = 300;

function Cell({ column, value }: { column: AdminDbColumn; value: unknown }) {
  if (column.sensitive) {
    return (
      <span className="admin-db-cell admin-db-cell--hidden" title="Not readable from this page">
        hidden
      </span>
    );
  }
  if (value === null || value === undefined) return <span className="admin-db-cell is-null">null</span>;
  if (typeof value === "boolean") {
    return <span className="admin-db-cell">{value ? "true" : "false"}</span>;
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return (
    <span className="admin-db-cell" title={text}>
      {text.length > CELL_MAX ? `${text.slice(0, CELL_MAX)}…` : text}
    </span>
  );
}

// ─── Row detail ──────────────────────────────────────────────────────────────

function RowViewDialog({
  columns,
  row,
  onClose,
}: {
  columns: AdminDbColumn[];
  row: Record<string, unknown>;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="admin-db-dialog">
        <DialogHeader>
          <DialogTitle>Row</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <dl className="admin-db-detail">
            {columns.map((c) => (
              <div key={c.name} className="admin-db-detail__row">
                <dt>
                  {c.name}
                  <span className="admin-db-detail__type">{c.dataType}</span>
                </dt>
                <dd>
                  {c.sensitive ? (
                    <span className="admin-db-cell--hidden">hidden</span>
                  ) : (
                    <pre className="admin-db-detail__value">{formatFull(row[c.name])}</pre>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Row editor ──────────────────────────────────────────────────────────────

interface FieldState {
  /** null models SQL NULL explicitly, so it's never confused with "". */
  value: string | null;
}

function RowEditDialog({
  table,
  columns,
  primaryKey,
  row,
  busy,
  onCancel,
  onSave,
}: {
  table: string;
  columns: AdminDbColumn[];
  primaryKey: string[];
  row: Record<string, unknown>;
  busy: boolean;
  onCancel: () => void;
  onSave: (values: Record<string, unknown>) => void;
}) {
  // Editable = not a primary key (identity, not data) and not a secret.
  const editable = useMemo(
    () => columns.filter((c) => !c.sensitive && !c.isPrimaryKey),
    [columns],
  );
  const [fields, setFields] = useState<Record<string, FieldState>>(() => {
    const out: Record<string, FieldState> = {};
    for (const c of editable) out[c.name] = { value: toInputValue(row[c.name]) };
    return out;
  });
  const [jsonError, setJsonError] = useState<string | null>(null);

  const set = (name: string, patch: Partial<FieldState>) =>
    setFields((prev) => ({ ...prev, [name]: { ...prev[name]!, ...patch } }));

  const submit = () => {
    setJsonError(null);
    const values: Record<string, unknown> = {};
    for (const c of editable) {
      const state = fields[c.name]!;
      const original = toInputValue(row[c.name]);
      if (state.value === original) continue; // untouched — leave it out of the UPDATE
      if (state.value === null) {
        values[c.name] = null;
        continue;
      }
      if (isJsonType(c.dataType)) {
        try {
          values[c.name] = JSON.parse(state.value);
        } catch {
          setJsonError(`${c.name} is not valid JSON`);
          return;
        }
      } else if (isBoolType(c.dataType)) {
        values[c.name] = state.value === "true";
      } else if (isNumericType(c.dataType)) {
        const n = Number(state.value);
        if (!Number.isFinite(n)) {
          setJsonError(`${c.name} must be a number`);
          return;
        }
        values[c.name] = n;
      } else {
        values[c.name] = state.value;
      }
    }
    if (Object.keys(values).length === 0) {
      onCancel();
      return;
    }
    onSave(values);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="admin-db-dialog">
        <DialogHeader>
          <DialogTitle>Edit row in {table}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-help">
            {describePk(pkOf(primaryKey, row))} · only changed fields are written.
          </p>
          {editable.map((c) => {
            const state = fields[c.name]!;
            const isNull = state.value === null;
            return (
              <div key={c.name} className="settings-field">
                <Label htmlFor={`db-${c.name}`} className="is-small">
                  {c.name}
                  <span className="admin-db-detail__type">{c.dataType}</span>
                </Label>
                <div className="admin-db-field-row">
                  {isBoolType(c.dataType) && !isNull ? (
                    <select
                      id={`db-${c.name}`}
                      className="input"
                      value={state.value ?? "false"}
                      onChange={(e) => set(c.name, { value: e.target.value })}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <Input
                      id={`db-${c.name}`}
                      value={state.value ?? ""}
                      placeholder={isNull ? "null" : undefined}
                      disabled={isNull}
                      onChange={(e) => set(c.name, { value: e.target.value })}
                    />
                  )}
                  {c.notNull ? null : isNull ? (
                    <Button variant="outline" size="sm" onClick={() => set(c.name, { value: "" })}>
                      Set value
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => set(c.name, { value: null })}>
                      Set null
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {editable.length === 0 && (
            <p className="text-help">Every column here is a primary key or a protected column.</p>
          )}
          {jsonError && <p className="text-error">{jsonError}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={editable.length === 0}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function pkOf(primaryKey: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of primaryKey) out[col] = row[col];
  return out;
}

function describePk(pk: Record<string, unknown>): string {
  return Object.entries(pk)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" · ");
}

/** Stable-ish React key: the primary key when there is one, else the index. */
function rowKeyOf(data: AdminDbRows, row: Record<string, unknown>, index: number): string {
  if (data.primaryKey.length === 0) return `row-${index}`;
  return data.primaryKey.map((c) => String(row[c])).join("|");
}

function toInputValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function formatFull(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

const isJsonType = (t: string) => /json/i.test(t);
const isBoolType = (t: string) => /^bool/i.test(t);
const isNumericType = (t: string) =>
  /^(smallint|integer|int|bigint|numeric|decimal|real|double)/i.test(t);

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Base64 of a file's bytes. FileReader handles large files without the call-stack limits of btoa loops. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const comma = url.indexOf(",");
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}
