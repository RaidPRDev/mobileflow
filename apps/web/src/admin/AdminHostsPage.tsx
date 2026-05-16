import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
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
} from "@mobileflow/ui";
import { CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { ApiError, api } from "../api/client";

type Kind = "linux_docker" | "mac";

interface HostRow {
  id: string;
  name: string;
  kind: Kind;
  hostname: string;
  port: number;
  sshUser: string;
  remoteBase: string;
  downloadsBase: string;
  downloadsBaseUrl: string;
  toolsPath: string | null;
  capacity: number;
  online: boolean;
  createdAt: string;
  source: "db" | "env";
  hasArtifactKey: boolean;
}

const DEFAULTS: Record<Kind, { remoteBase: string; downloadsBase: string; toolsPath: string }> = {
  linux_docker: {
    remoteBase: "/root/RaidX/Clients",
    downloadsBase: "/root/RaidX/downloads",
    toolsPath: "/root/RaidX/Tools/android",
  },
  mac: {
    remoteBase: "/Users/build/RaidX/Clients",
    downloadsBase: "/Users/build/RaidX/downloads",
    toolsPath: "/Users/build/RaidX/Tools",
  },
};

const KIND_LABEL: Record<Kind, string> = {
  linux_docker: "Linux · Docker",
  mac: "Mac",
};

export function AdminHostsPage() {
  const q = useQuery({ queryKey: ["admin", "hosts"], queryFn: () => api.admin.hosts() });
  const [showForm, setShowForm] = useState(false);

  const hosts = (q.data ?? []) as HostRow[];

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">Build hosts</h1>
        </div>
        <Button onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "Add host"}
        </Button>
      </header>
      <p className="page-subtitle">
        Hosts added here take precedence over the matching <code>LINUX_BUILD_*</code> /{" "}
        <code>MAC_BUILD_*</code> env vars. Env-defined rows are read-only and shown here for reference.
      </p>

      {showForm && <NewHostCard onDone={() => setShowForm(false)} />}

      {q.isLoading && <div className="builds-status">Loading hosts…</div>}
      {q.error && (
        <div className="builds-status is-error">{(q.error as Error).message}</div>
      )}

      {!q.isLoading && hosts.length === 0 && (
        <div className="empty-state">
          <h2 className="empty-state__title">No hosts</h2>
          <p className="empty-state__body">Add one above, or configure the <code>*_BUILD_*</code> env vars.</p>
        </div>
      )}

      {!!hosts.length && (
        <div className="data-grid admin-hosts-table" role="table">
          <div className="data-grid__head" role="row">
            <span role="columnheader">Host</span>
            <span role="columnheader">Kind</span>
            <span role="columnheader">Address</span>
            <span role="columnheader">
              <span className="tooltip-wrap admin-hosts-table__capacity-head" tabIndex={0}>
                Capacity
                <Info size={12} aria-hidden />
                <span className="tooltip-bubble tooltip-bubble--wide" role="tooltip">
                  Intended max concurrent builds per host. Not yet honored by the scheduler — the value is stored but doesn't affect build placement.
                </span>
              </span>
            </span>
            <span role="columnheader">Source</span>
            <span role="columnheader">Status</span>
            <span role="columnheader" aria-label="Actions"></span>
          </div>
          {hosts.map((h) => (
            <HostRowItem key={h.id} host={h} />
          ))}
        </div>
      )}
    </div>
  );
}

function HostRowItem({ host }: { host: HostRow }) {
  const qc = useQueryClient();
  const isEnv = host.source === "env";
  const [testOpen, setTestOpen] = useState(false);
  const [pushKeyOpen, setPushKeyOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  const setOnline = useMutation({
    mutationFn: (online: boolean) => api.admin.patchHost(host.id, { online }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "hosts"] }),
  });
  const remove = useMutation({
    mutationFn: () => api.admin.deleteHost(host.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "hosts"] }),
  });
  const test = useMutation({
    mutationFn: () => api.admin.testHost(host.id),
  });

  const openTest = () => {
    test.reset();
    setTestOpen(true);
    test.mutate();
  };

  return (
    <div className="data-grid__row builds-row" role="row">
      <div role="cell">
        <span className="builds-row__triggered-name">{host.name}</span>
      </div>
      <div role="cell">
        <code className="plan-card__id">{KIND_LABEL[host.kind]}</code>
      </div>
      <div role="cell" className="admin-hosts-row__addr">
        {host.sshUser}@{host.hostname}:{host.port}
      </div>
      <div role="cell" className="admin-plans-row__num">{host.capacity}</div>
      <div role="cell">
        <span className={`admin-hosts-row__source admin-hosts-row__source--${host.source}`}>
          {host.source.toUpperCase()}
        </span>
      </div>
      <div role="cell" className="builds-row__status">
        {host.online ? (
          <span className="tooltip-wrap" tabIndex={0}>
            <CheckCircle2 size={18} className="status-icon is-success" aria-hidden />
            <span className="tooltip-bubble" role="tooltip">Online</span>
          </span>
        ) : (
          <span className="tooltip-wrap" tabIndex={0}>
            <XCircle size={18} className="status-icon is-failed" aria-hidden />
            <span className="tooltip-bubble" role="tooltip">Offline</span>
          </span>
        )}
      </div>
      <div role="cell" className="builds-row__menu">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton variant="menu" aria-label={`Actions for ${host.name}`} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={test.isPending}
              onSelect={openTest}
            >
              Test connection
            </DropdownMenuItem>
            {host.kind === "mac" && !isEnv && (
              <DropdownMenuItem onSelect={() => setPushKeyOpen(true)}>
                {host.hasArtifactKey ? "Re-push artifact key…" : "Push artifact key…"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setCleanupOpen(true)}>
              Clean up orphans…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isEnv || setOnline.isPending}
              title={isEnv ? "Env hosts are always available when configured" : undefined}
              onSelect={() => setOnline.mutate(!host.online)}
            >
              {host.online ? "Mark offline" : "Mark online"}
            </DropdownMenuItem>
            {!isEnv && (
              <DropdownMenuItem
                destructive
                disabled={remove.isPending}
                onSelect={() => {
                  if (confirm(`Delete host "${host.name}"?`)) remove.mutate();
                }}
              >
                Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <TestConnectionDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        hostName={host.name}
        isPending={test.isPending}
        error={test.error as Error | null}
        result={test.data ?? null}
      />
      {host.kind === "mac" && !isEnv && (
        <PushArtifactKeyDialog
          open={pushKeyOpen}
          onOpenChange={setPushKeyOpen}
          hostId={host.id}
          hostName={host.name}
          hasExistingKey={host.hasArtifactKey}
        />
      )}
      <CleanupOrphansDialog
        open={cleanupOpen}
        onOpenChange={setCleanupOpen}
        hostId={host.id}
        hostName={host.name}
      />
    </div>
  );
}

interface TestResult {
  ok: boolean;
  exitCode?: number;
  output?: string;
  error?: string;
}

function TestConnectionDialog({
  open,
  onOpenChange,
  hostName,
  isPending,
  error,
  result,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostName: string;
  isPending: boolean;
  error: Error | null;
  result: TestResult | null;
}) {
  const status: "pending" | "success" | "fail" =
    isPending || (!result && !error) ? "pending" : error || !result?.ok ? "fail" : "success";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="ssh-test__heading">
            <DialogTitle>Test connection</DialogTitle>
            <DialogDescription>
              SSH into <strong>{hostName}</strong> and run <code>uname -a</code>.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          <div className="ssh-test">
            <div className={`ssh-test__icon is-${status}`}>
              {status === "pending" && <Loader2 className="ssh-test__spinner" size={48} aria-hidden />}
              {status === "success" && <AnimatedCheck />}
              {status === "fail" && <XCircle size={48} strokeWidth={1.75} aria-hidden />}
            </div>
            <div className="ssh-test__caption">
              {status === "pending" && "Connecting…"}
              {status === "success" && "Connection successful"}
              {status === "fail" && "Connection failed"}
            </div>
            {status !== "pending" && (
              <pre className="ssh-test__output">
                {status === "success"
                  ? result?.output || "(no output)"
                  : error?.message || result?.error || "Unknown error"}
              </pre>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AnimatedCheck() {
  return (
    <svg
      className="ssh-test__check"
      width="48"
      height="48"
      viewBox="0 0 52 52"
      aria-hidden
    >
      <circle className="ssh-test__check-circle" cx="26" cy="26" r="24" fill="none" />
      <path className="ssh-test__check-mark" fill="none" d="M14 27 L23 36 L39 18" />
    </svg>
  );
}

function NewHostCard({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>("linux_docker");
  const [form, setForm] = useState({
    name: "",
    hostname: "",
    port: 22,
    sshUser: kind === "linux_docker" ? "root" : "",
    sshKey: "",
    artifactKey: "",
    remoteBase: DEFAULTS[kind].remoteBase,
    downloadsBase: DEFAULTS[kind].downloadsBase,
    downloadsBaseUrl: "https://xbuilds.raidpr.com",
    toolsPath: DEFAULTS[kind].toolsPath,
    capacity: 2,
    online: true,
  });
  const [error, setError] = useState<string | null>(null);

  const onKind = (next: Kind) => {
    setKind(next);
    setForm((f) => ({ ...f, ...DEFAULTS[next], sshUser: next === "linux_docker" ? "root" : "" }));
  };

  const create = useMutation({
    mutationFn: () =>
      api.admin.createHost({
        ...form,
        kind,
        // Only send artifactKey for Mac hosts; the API ignores it otherwise but
        // keep payloads tidy.
        artifactKey: kind === "mac" && form.artifactKey ? form.artifactKey : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "hosts"] });
      onDone();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New build host</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="plan-card__fields">
          <Field label="Kind">
            <div className="row">
              <Button
                size="sm"
                variant={kind === "linux_docker" ? "default" : "outline"}
                onClick={() => onKind("linux_docker")}
              >
                Linux (Docker)
              </Button>
              <Button
                size="sm"
                variant={kind === "mac" ? "default" : "outline"}
                onClick={() => onKind("mac")}
              >
                Mac
              </Button>
            </div>
          </Field>
          <Field label="Display name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Hostname / IP">
            <Input value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} />
          </Field>
          <Field label="Port">
            <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
          </Field>
          <Field label="SSH user">
            <Input value={form.sshUser} onChange={(e) => setForm({ ...form, sshUser: e.target.value })} />
          </Field>
          <Field label="Capacity">
            <Input type="number" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })} />
          </Field>
          <Field label="Remote base">
            <Input value={form.remoteBase} onChange={(e) => setForm({ ...form, remoteBase: e.target.value })} />
          </Field>
          <Field label="Downloads base (path)">
            <Input value={form.downloadsBase} onChange={(e) => setForm({ ...form, downloadsBase: e.target.value })} />
          </Field>
          <Field label="Downloads base URL">
            <Input value={form.downloadsBaseUrl} onChange={(e) => setForm({ ...form, downloadsBaseUrl: e.target.value })} />
          </Field>
          <Field label="Tools path (optional)">
            <Input value={form.toolsPath} onChange={(e) => setForm({ ...form, toolsPath: e.target.value })} />
          </Field>
        </div>
        <Field label="Private SSH key (PEM)">
          <PemKeyInput
            value={form.sshKey}
            onChange={(v) => setForm({ ...form, sshKey: v })}
          />
        </Field>
        {kind === "mac" && (
          <Field
            label="Artifact-server SSH key (Mac → Linux)"
            hint="Required — pushed to the Mac at ~/.ssh/raidx_linux_key so it can scp build artifacts to the Linux downloads host. Without it, iOS builds will succeed locally but fail at the artifact-upload step."
          >
            <PemKeyInput
              value={form.artifactKey}
              onChange={(v) => setForm({ ...form, artifactKey: v })}
            />
          </Field>
        )}
        {error && <p className="text-error">{error}</p>}
        <div className="row-end">
          <Button variant="outline" onClick={onDone}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={
              !form.name ||
              !form.hostname ||
              !form.sshUser ||
              !form.sshKey ||
              (kind === "mac" && !form.artifactKey)
            }
          >
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="plan-card__field">
      <Label className="plan-card__field-label">{label}</Label>
      {children}
      {hint && <p className="plan-card__field-hint">{hint}</p>}
    </div>
  );
}

// Lets the admin either paste a PEM private key or pick one from disk. The
// uploaded file's text is loaded into the same textarea so the user can
// glance at it before saving. Accepts both `.pem` and `id_*` style files
// (most private keys have no extension), so we don't filter by accept.
function PemKeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const onPick = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      onChange(text);
    };
    reader.readAsText(file);
  };
  return (
    <div className="pem-key-input">
      <textarea
        className="admin-hosts-form__key"
        value={value}
        onChange={(e) => {
          setFileName(null);
          onChange(e.target.value);
        }}
        placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
        spellCheck={false}
      />
      <div className="pem-key-input__actions">
        <label className="pem-key-input__upload">
          <input
            type="file"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <span>Upload key file</span>
        </label>
        {fileName && <span className="pem-key-input__filename">{fileName}</span>}
        {!fileName && value && (
          <button
            type="button"
            className="pem-key-input__clear"
            onClick={() => onChange("")}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function PushArtifactKeyDialog({
  open,
  onOpenChange,
  hostId,
  hostName,
  hasExistingKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostId: string;
  hostName: string;
  hasExistingKey: boolean;
}) {
  const qc = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const push = useMutation({
    mutationFn: () =>
      api.admin.pushArtifactKey(hostId, newKey ? { artifactKey: newKey } : undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "hosts"] }),
  });

  // Reset state when the dialog re-opens.
  useEffectOnOpen(open, () => {
    setNewKey("");
    push.reset();
  });

  const result = push.data ?? null;
  const error = push.error as Error | null;
  const isPending = push.isPending;
  const idle = !isPending && !result && !error;
  const status: "idle" | "pending" | "success" | "fail" = idle
    ? "idle"
    : isPending
      ? "pending"
      : error || !result?.ok
        ? "fail"
        : "success";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="ssh-test__heading">
            <DialogTitle>
              {hasExistingKey ? "Re-push artifact-server key" : "Push artifact-server key"}
            </DialogTitle>
            <DialogDescription>
              SSH into <strong>{hostName}</strong>, write the key to{" "}
              <code>~/.ssh/raidx_linux_key</code>, ssh-keyscan the Linux host, then verify by
              running <code>echo ok</code> over the new key.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {status === "idle" && (
            <div className="plan-card__field">
              <Label className="plan-card__field-label">
                {hasExistingKey
                  ? "Paste a new key (optional — leave blank to re-push the stored key)"
                  : "Paste the Mac → Linux private key (PEM)"}
              </Label>
              <PemKeyInput value={newKey} onChange={setNewKey} />
            </div>
          )}
          {status !== "idle" && (
            <div className="ssh-test">
              <div className={`ssh-test__icon is-${status === "pending" ? "pending" : status}`}>
                {status === "pending" && <Loader2 className="ssh-test__spinner" size={48} aria-hidden />}
                {status === "success" && <AnimatedCheck />}
                {status === "fail" && <XCircle size={48} strokeWidth={1.75} aria-hidden />}
              </div>
              <div className="ssh-test__caption">
                {status === "pending" && "Pushing…"}
                {status === "success" && "Key pushed and verified"}
                {status === "fail" && "Push failed"}
              </div>
              {status !== "pending" && (
                <pre className="ssh-test__output">
                  {status === "success"
                    ? result?.output || "(no output)"
                    : error?.message || result?.error || "Unknown error"}
                </pre>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {status === "idle" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                onClick={() => push.mutate()}
                disabled={!hasExistingKey && !newKey}
                loading={isPending}
              >
                Push key
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Tiny helper: run an effect every time `open` flips from false to true.
function useEffectOnOpen(open: boolean, fn: () => void) {
  const prev = useRef(open);
  if (open && !prev.current) fn();
  prev.current = open;
}

// Scan-then-delete cleanup of orphan build dirs on the host. Two-phase: a
// dry-run scan fires on open and lists what would be deleted; the user then
// confirms with a button to actually `rm -rf` them. Reuses the spinner /
// animated check / X visual from the Test Connection dialog.
function CleanupOrphansDialog({
  open,
  onOpenChange,
  hostId,
  hostName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostId: string;
  hostName: string;
}) {
  const scan = useMutation({
    mutationFn: () => api.admin.cleanupOrphans(hostId, { dryRun: true }),
  });
  const remove = useMutation({
    mutationFn: () => api.admin.cleanupOrphans(hostId, {}),
  });

  // Run the dry-run scan as soon as the dialog opens; reset both mutations
  // when it closes so reopening starts fresh.
  useEffectOnOpen(open, () => {
    scan.reset();
    remove.reset();
    scan.mutate();
  });

  const scanData = scan.data;
  const removeData = remove.data;
  const scanError = scan.error as Error | null;
  const removeError = remove.error as Error | null;

  // Dialog state machine: scanning → scanned (preview) → deleting → done.
  const status: "scanning" | "scan-failed" | "preview" | "deleting" | "done-success" | "done-fail" =
    remove.isPending
      ? "deleting"
      : removeData
        ? removeData.ok ? "done-success" : "done-fail"
        : removeError
          ? "done-fail"
          : scan.isPending || (!scanData && !scanError)
            ? "scanning"
            : scanError || (scanData && !scanData.ok)
              ? "scan-failed"
              : "preview";

  const total = scanData?.totalOrphans ?? 0;
  const orphanList = scanData
    ? [...(scanData.remoteOrphans ?? []), ...(scanData.downloadOrphans ?? [])]
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <div className="ssh-test__heading">
            <DialogTitle>Clean up orphan builds</DialogTitle>
            <DialogDescription>
              Scans <strong>{hostName}</strong> for build dirs whose ids no longer exist in the
              database and deletes them. Linux hosts also clear stale artifacts from the downloads
              folder.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {/* Status icon mirrors Test Connection. "preview" is the only state
              without an icon — we show the preview list instead. */}
          {status !== "preview" && (
            <div className="ssh-test">
              <div
                className={`ssh-test__icon is-${
                  status === "scanning" || status === "deleting"
                    ? "pending"
                    : status === "done-success"
                      ? "success"
                      : "fail"
                }`}
              >
                {(status === "scanning" || status === "deleting") && (
                  <Loader2 className="ssh-test__spinner" size={48} aria-hidden />
                )}
                {status === "done-success" && <AnimatedCheck />}
                {(status === "scan-failed" || status === "done-fail") && (
                  <XCircle size={48} strokeWidth={1.75} aria-hidden />
                )}
              </div>
              <div className="ssh-test__caption">
                {status === "scanning" && "Scanning host…"}
                {status === "deleting" && `Deleting ${total} orphan${total === 1 ? "" : "s"}…`}
                {status === "done-success" && (removeData?.deleted ?? 0) === 0
                  ? "Nothing to delete"
                  : status === "done-success"
                    ? `Deleted ${removeData?.deleted ?? 0} orphan${(removeData?.deleted ?? 0) === 1 ? "" : "s"}`
                    : null}
                {status === "scan-failed" && "Scan failed"}
                {status === "done-fail" && "Cleanup failed"}
              </div>
              {(status === "done-success" || status === "done-fail" || status === "scan-failed") && (
                <pre className="ssh-test__output">
                  {status === "scan-failed"
                    ? scanError?.message || scanData?.error || "Unknown error"
                    : status === "done-fail"
                      ? removeError?.message || removeData?.error || "Unknown error"
                      : removeData?.deleteLog || "(no output)"}
                </pre>
              )}
            </div>
          )}
          {status === "preview" && (
            <div className="cleanup-preview">
              {total === 0 ? (
                <div className="ssh-test">
                  <div className="ssh-test__icon is-success"><AnimatedCheck /></div>
                  <div className="ssh-test__caption">No orphans found</div>
                </div>
              ) : (
                <>
                  <p className="cleanup-preview__summary">
                    Found <strong>{total}</strong> orphan{total === 1 ? "" : "s"} on this host.
                  </p>
                  {(scanData?.remoteOrphans ?? []).length > 0 && (
                    <CleanupSection
                      title={`Build sandboxes (${scanData?.remoteBase ?? ""})`}
                      paths={scanData!.remoteOrphans!}
                    />
                  )}
                  {(scanData?.downloadOrphans ?? []).length > 0 && (
                    <CleanupSection
                      title={`Downloads (${scanData?.downloadsBase ?? ""})`}
                      paths={scanData!.downloadOrphans!}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {status === "preview" && total > 0 && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => remove.mutate()} variant="destructive">
                Delete {total} orphan{total === 1 ? "" : "s"}
              </Button>
            </>
          )}
          {(status === "preview" && total === 0) ||
          status === "done-success" ||
          status === "done-fail" ||
          status === "scan-failed" ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : null}
          {(status === "scanning" || status === "deleting") && (
            <Button variant="outline" disabled>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Truncates long preview lists to keep the dialog readable while still
// surfacing what's about to be deleted.
function CleanupSection({ title, paths }: { title: string; paths: string[] }) {
  const MAX = 8;
  const shown = paths.slice(0, MAX);
  const extra = paths.length - shown.length;
  return (
    <div className="cleanup-preview__section">
      <div className="cleanup-preview__section-title">{title}</div>
      <ul className="cleanup-preview__list">
        {shown.map((p) => (
          <li key={p}>{p}</li>
        ))}
        {extra > 0 && <li className="cleanup-preview__more">… and {extra} more</li>}
      </ul>
    </div>
  );
}
