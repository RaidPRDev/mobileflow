import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Switch, cn } from "@mobileflow/ui";
import { ChevronLeft, Copy, FileText, Folder, RefreshCw, Trash2 } from "lucide-react";
import {
  api,
  type AdminLogFile,
  type AdminLogFolder,
  type AdminLogScope,
} from "../api/client";

type Level = "scopes" | "years" | "months" | "files";

interface NavState {
  level: Level;
  scope: AdminLogScope | null;
  year: AdminLogFolder | null;
  month: AdminLogFolder | null;
}

const REFRESH_MS = 2500;

export function AdminLogsPage() {
  const qc = useQueryClient();
  const [nav, setNav] = useState<NavState>({
    level: "scopes",
    scope: null,
    year: null,
    month: null,
  });
  const [slideKey, setSlideKey] = useState(0);
  const [scopes, setScopes] = useState<AdminLogScope[]>([]);
  const [years, setYears] = useState<AdminLogFolder[]>([]);
  const [months, setMonths] = useState<AdminLogFolder[]>([]);
  const [files, setFiles] = useState<AdminLogFile[]>([]);
  const [selected, setSelected] = useState<AdminLogFile | null>(null);
  const [content, setContent] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reloadList = useCallback(async () => {
    setError(null);
    try {
      if (nav.level === "scopes") {
        setScopes(await api.admin.logScopes());
      } else if (nav.level === "years" && nav.scope) {
        setYears(await api.admin.logYears(nav.scope.id));
      } else if (nav.level === "months" && nav.scope && nav.year) {
        setMonths(await api.admin.logMonths(nav.scope.id, nav.year.name));
      } else if (nav.level === "files" && nav.scope && nav.year && nav.month) {
        setFiles(await api.admin.logFiles(nav.scope.id, nav.year.name, nav.month.name));
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [nav]);

  useEffect(() => {
    void reloadList();
  }, [reloadList]);

  const reloadFile = useCallback(async () => {
    if (!selected || !nav.scope || !nav.year || !nav.month) return;
    setError(null);
    try {
      const snap = await api.admin.readLog({
        scope: nav.scope.id,
        year: nav.year.name,
        month: nav.month.name,
        file: selected.name,
      });
      setContent(snap.content);
      setTruncated(snap.truncated);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [nav.month, nav.scope, nav.year, selected]);

  useEffect(() => {
    void reloadFile();
  }, [reloadFile]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      void reloadFile();
      if (nav.level === "files") void reloadList();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, nav.level, reloadFile, reloadList]);

  function go(next: NavState) {
    setNav(next);
    setSlideKey((value) => value + 1);
  }

  function goBack() {
    if (nav.level === "files") go({ ...nav, level: "months", month: null });
    else if (nav.level === "months") go({ ...nav, level: "years", year: null });
    else if (nav.level === "years") go({ level: "scopes", scope: null, year: null, month: null });
  }

  async function deleteSelected(file: AdminLogFile) {
    if (!nav.scope || !nav.year || !nav.month) return;
    const ok = window.confirm(`Delete log file?\n\n${file.name}`);
    if (!ok) return;
    await api.admin.deleteLog({
      scope: nav.scope.id,
      year: nav.year.name,
      month: nav.month.name,
      file: file.name,
    });
    if (selected?.name === file.name) {
      setSelected(null);
      setContent("");
      setTruncated(false);
    }
    await reloadList();
    await qc.invalidateQueries({ queryKey: ["admin", "stats"] });
  }

  function copyPath(path: string) {
    void navigator.clipboard?.writeText(path);
  }

  return (
    <div className="page admin-logs-page">
      <header className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">Logs</h1>
          <p className="page-subtitle">
            Global API activity with isolated per-user views for account-level review.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void reloadList()}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </Button>
      </header>

      {error && <div className="admin-logs-error">{error}</div>}

      <div className="admin-logviewer">
        <aside className="admin-logviewer__sidebar">
          <div className="admin-logviewer__sidebar-header">
            {nav.level !== "scopes" ? (
              <button type="button" className="admin-logviewer__back" onClick={goBack} aria-label="Back">
                <ChevronLeft size={16} aria-hidden />
                <span>Back</span>
              </button>
            ) : (
              <span className="admin-logviewer__title">Scopes</span>
            )}
            <button
              type="button"
              className="admin-logviewer__refresh-btn"
              onClick={() => void reloadList()}
              aria-label="Refresh list"
              title="Refresh list"
            >
              <RefreshCw size={14} aria-hidden />
            </button>
          </div>

          {nav.level !== "scopes" && (
            <div className="admin-logviewer__crumbs">
              {nav.scope?.label}
              {nav.year ? ` / ${nav.year.name}` : ""}
              {nav.month ? ` / ${monthLabel(nav.month.name)}` : ""}
            </div>
          )}

          <div key={slideKey} className="admin-logviewer__panel admin-logviewer__panel--slide app-scroll">
            {nav.level === "scopes" && (
              <RowsEmpty empty={scopes.length === 0} label="No log scopes yet">
                {scopes.map((scope) => (
                  <SidebarRow
                    key={scope.id}
                    icon={<Folder size={14} />}
                    label={scope.label}
                    sub={scope.kind === "global" ? "All authenticated traffic" : "User account"}
                    onClick={() => go({ level: "years", scope, year: null, month: null })}
                    menu={[
                      { label: "Copy path", icon: <Copy size={14} />, onSelect: () => copyPath(scope.path) },
                    ]}
                  />
                ))}
              </RowsEmpty>
            )}

            {nav.level === "years" && (
              <RowsEmpty empty={years.length === 0} label="No years">
                {years.map((year) => (
                  <SidebarRow
                    key={year.path}
                    icon={<Folder size={14} />}
                    label={year.name}
                    onClick={() => go({ ...nav, level: "months", year, month: null })}
                    menu={[
                      { label: "Copy path", icon: <Copy size={14} />, onSelect: () => copyPath(year.path) },
                    ]}
                  />
                ))}
              </RowsEmpty>
            )}

            {nav.level === "months" && (
              <RowsEmpty empty={months.length === 0} label="No months">
                {months.map((month) => (
                  <SidebarRow
                    key={month.path}
                    icon={<Folder size={14} />}
                    label={monthLabel(month.name)}
                    onClick={() => go({ ...nav, level: "files", month })}
                    menu={[
                      { label: "Copy path", icon: <Copy size={14} />, onSelect: () => copyPath(month.path) },
                    ]}
                  />
                ))}
              </RowsEmpty>
            )}

            {nav.level === "files" && (
              <RowsEmpty empty={files.length === 0} label="No log files">
                {files.map((file) => {
                  const active = selected?.name === file.name && selected.path === file.path;
                  const label = logFileLabel(file.name);
                  return (
                    <SidebarRow
                      key={file.path}
                      icon={<FileText size={14} />}
                      label={label.date}
                      sub={`${label.session} · ${formatBytes(file.size)}`}
                      active={active}
                      onClick={() => setSelected(file)}
                      menu={[
                        { label: "Copy path", icon: <Copy size={14} />, onSelect: () => copyPath(file.path) },
                        {
                          label: "Delete",
                          icon: <Trash2 size={14} />,
                          destructive: true,
                          onSelect: () => void deleteSelected(file),
                        },
                      ]}
                    />
                  );
                })}
              </RowsEmpty>
            )}
          </div>
        </aside>

        <section className="admin-logviewer__main">
          <header className="admin-logviewer__main-header">
            <div className="admin-logviewer__main-title">
              {selected ? selected.name : "Select a log file"}
            </div>
            <label className="admin-logviewer__refresh">
              <span>Auto-refresh</span>
              <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
            </label>
          </header>
          {truncated && (
            <div className="admin-logviewer__truncated">
              Showing the latest 2 MB. Older lines are omitted.
            </div>
          )}
          <LogContent text={content} empty={!selected} />
        </section>
      </div>
    </div>
  );
}

function RowsEmpty({
  empty,
  label,
  children,
}: {
  empty: boolean;
  label: string;
  children: ReactNode;
}) {
  if (empty) return <div className="admin-logviewer__empty">{label}</div>;
  return <>{children}</>;
}

interface MenuEntry {
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  onSelect: () => void;
}

function SidebarRow({
  icon,
  label,
  sub,
  active,
  onClick,
  menu,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  active?: boolean;
  onClick: () => void;
  menu: MenuEntry[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={cn("admin-logviewer__row", active && "is-active")}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <button type="button" className="admin-logviewer__row-button" onClick={onClick}>
        <span className="admin-logviewer__row-icon">{icon}</span>
        <span className="admin-logviewer__row-label">
          <span className="admin-logviewer__row-label-main">{label}</span>
          {sub && <span className="admin-logviewer__row-label-sub">{sub}</span>}
        </span>
      </button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger className="admin-logviewer__row-menu" aria-label="Row actions">
          ...
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {menu.map((entry) => (
            <DropdownMenuItem
              key={entry.label}
              destructive={entry.destructive}
              icon={entry.icon}
              onSelect={entry.onSelect}
            >
              {entry.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function LogContent({ text, empty }: { text: string; empty: boolean }) {
  const lines = useMemo(() => {
    const arr = text.split("\n");
    if (arr.length && arr[arr.length - 1] === "") arr.pop();
    return arr;
  }, [text]);

  if (empty) {
    return <div className="admin-logviewer__content admin-logviewer__content--empty">Pick a log file.</div>;
  }
  if (lines.length === 0) {
    return <div className="admin-logviewer__content admin-logviewer__content--empty">(empty file)</div>;
  }
  return (
    <div className="admin-logviewer__content app-scroll">
      {lines.map((raw, index) => (
        <LogLineRow key={`${index}-${raw}`} raw={raw} />
      ))}
    </div>
  );
}

const LogLineRow = memo(function LogLineRow({ raw }: { raw: string }) {
  const parsed = parseLogLine(raw);
  return (
    <div className={cn("admin-logline", `admin-logline--${parsed.level}`)}>
      <div className="admin-logline__inline">
        {parsed.timestamp != null && (
          <span className="admin-logline__ts">{formatTimestamp(parsed.timestamp)}</span>
        )}
        {parsed.event && <span className="admin-logline__event">{parsed.event}</span>}
        {parsed.fields && (
          <span className="admin-logline__fields">
            {Object.entries(parsed.fields).map(([key, value]) => (
              <span key={key} className="admin-logline__field">
                <span className="admin-logline__field-key">{key}</span>
                <span className="admin-logline__field-eq">=</span>
                <span className="admin-logline__field-value">{value}</span>
              </span>
            ))}
          </span>
        )}
        {parsed.rest && <span className="admin-logline__rest">{parsed.rest}</span>}
      </div>
    </div>
  );
});

function parseLogLine(raw: string): {
  timestamp: number | null;
  event: string;
  fields: Record<string, string> | null;
  rest: string;
  level: "debug" | "info" | "warn" | "error" | "plain";
} {
  const match = raw.match(/^\[(\d+)]\s+(\S+)\s*(.*)$/);
  if (!match) return { timestamp: null, event: "", fields: null, rest: raw, level: "plain" };
  const rest = match[3] ?? "";
  const fields: Record<string, string> = {};
  const fieldRe = /(\w+)=("([^"\\]|\\.)*"|\S+)/g;
  let fieldMatch: RegExpExecArray | null;
  while ((fieldMatch = fieldRe.exec(rest)) != null) {
    const key = fieldMatch[1];
    const value = fieldMatch[2];
    if (key && value) fields[key] = unquote(value);
  }
  const event = match[2] ?? "";
  const status = fields.status ? Number(fields.status) : 0;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : event.includes("debug") ? "debug" : "info";
  return {
    timestamp: Number(match[1]),
    event,
    fields: Object.keys(fields).length > 0 ? fields : null,
    rest: Object.keys(fields).length > 0 ? "" : rest,
    level,
  };
}

function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

function monthLabel(name: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = Number.parseInt(name, 10);
  const label = months[month - 1];
  if (Number.isFinite(month) && label) return `${label} (${name})`;
  return name;
}

function logFileLabel(name: string): { date: string; session: string } {
  const match = name.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.log$/);
  if (!match) return { date: name, session: "" };
  return { date: match[1] ?? name, session: match[2] ?? "" };
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
