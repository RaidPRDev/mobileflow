import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APP_NAME } from "@mobileflow/shared";
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
  Input,
  Label,
  Loading,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@mobileflow/ui";
import { Info, Loader2, XCircle } from "lucide-react";
import { CheckIcon } from "../components/CheckIcon";
import { ApiError, api } from "../api/client";
import { CircleXBig } from "../components/CircleXBig";
import { Collapse } from "../components/Collapse";
import { RowActionsButton, RowContextMenu, type RowAction } from "../components/RowActions";
import { clearTextSelection, isInteractiveTarget } from "../lib/rowInteractions";
import { HostTerminalPanel } from "./HostTerminalPanel";
import { ServerSetupDialog } from "./ServerSetupDialog";

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

// Display only — the stored `kind` stays `linux_docker`, which is what the API
// and the LINUX_BUILD_* env vars key off.
const KIND_LABEL: Record<Kind, string> = {
  linux_docker: "Unix",
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

      {q.isLoading && (
        <div className="builds-status">
          <Loading>Loading hosts…</Loading>
        </div>
      )}
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
        <div className="data-grid admin-hosts-table fade-in" role="table">
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
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

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

  // One list feeds both the ⋮ button and the right-click menu so they can't
  // drift apart. Env-defined rows live in env vars, so editing/deleting them
  // here would be a no-op — the items stay visible but disabled to explain why.
  const actions: RowAction[] = [
    {
      label: "Edit…",
      disabled: isEnv,
      title: isEnv ? "Env-defined hosts are read-only — change the *_BUILD_* env vars" : undefined,
      onSelect: () => setEditOpen(true),
    },
    { label: "Test connection", disabled: test.isPending, onSelect: openTest },
    ...(host.kind === "mac" && !isEnv
      ? [
          {
            label: host.hasArtifactKey ? "Re-push artifact key…" : "Push artifact key…",
            onSelect: () => setPushKeyOpen(true),
          },
        ]
      : []),
    { label: "Clean up orphans…", onSelect: () => setCleanupOpen(true) },
    { label: "Terminal", onSelect: () => setTerminalOpen(true) },
    {
      label: host.online ? "Mark offline" : "Mark online",
      disabled: isEnv || setOnline.isPending,
      title: isEnv ? "Env hosts are always available when configured" : undefined,
      onSelect: () => setOnline.mutate(!host.online),
    },
    ...(isEnv
      ? []
      : [
          {
            label: "Delete",
            destructive: true,
            disabled: remove.isPending,
            onSelect: () => {
              if (confirm(`Delete host "${host.name}"?`)) remove.mutate();
            },
          },
        ]),
  ];

  return (
    // The dialogs are siblings of the context-menu trigger, not children of it.
    // They portal their DOM to <body>, but React events travel the React tree,
    // so while they were nested inside the row a right-click anywhere in an open
    // dialog — including its full-screen overlay — bubbled back to the trigger
    // and popped this row's menu on top of the modal. Nothing is added to the
    // grid by moving them: every one of them renders through a portal, and
    // `.data-grid__row` is `display: contents`.
    <>
      <RowContextMenu actions={actions}>
        <div
          className="data-grid__row builds-row"
          role="row"
          onDoubleClick={(e) => {
            if (isEnv || isInteractiveTarget(e.target)) return;
            clearTextSelection();
            setEditOpen(true);
          }}
        >
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
                <CheckIcon size={24} className="status-icon is-success" aria-hidden />
                <span className="tooltip-bubble" role="tooltip">Online</span>
              </span>
            ) : (
              <span className="tooltip-wrap" tabIndex={0}>
                <CircleXBig size={24} className="status-icon is-failed" aria-hidden />
                <span className="tooltip-bubble" role="tooltip">Offline</span>
              </span>
            )}
          </div>
          <div role="cell" className="builds-row__menu">
            <RowActionsButton actions={actions} ariaLabel={`Actions for ${host.name}`} />
          </div>
        </div>
      </RowContextMenu>

      <TestConnectionDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        hostName={host.name}
        isPending={test.isPending}
        error={test.error as Error | null}
        result={test.data ?? null}
      />
      {!isEnv && editOpen && <EditHostDialog host={host} onClose={() => setEditOpen(false)} />}
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
      <HostTerminalPanel
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
        hostId={host.id}
        hostName={host.name}
      />
    </>
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

interface HostForm {
  name: string;
  hostname: string;
  port: number;
  sshUser: string;
  sshKey: string;
  artifactKey: string;
  remoteBase: string;
  downloadsBase: string;
  downloadsBaseUrl: string;
  toolsPath: string;
  capacity: number;
  online: boolean;
}

function NewHostCard({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>("linux_docker");
  const [form, setForm] = useState<HostForm>({
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
        <HostFields mode="create" kind={kind} onKind={onKind} form={form} setForm={setForm} />
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

// Edits a DB-backed host. Reached from the row's Edit action or by
// double-clicking the row. Key material is write-only — the API never returns
// it, so both key fields start blank and are only sent when the admin pastes a
// replacement.
function EditHostDialog({ host, onClose }: { host: HostRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>(host.kind);
  const [testOpen, setTestOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const test = useMutation({ mutationFn: () => api.admin.testHost(host.id) });
  const openTest = () => {
    test.reset();
    setTestOpen(true);
    test.mutate();
  };
  const [form, setForm] = useState<HostForm>({
    name: host.name,
    hostname: host.hostname,
    port: host.port,
    sshUser: host.sshUser,
    sshKey: "",
    artifactKey: "",
    remoteBase: host.remoteBase,
    downloadsBase: host.downloadsBase,
    downloadsBaseUrl: host.downloadsBaseUrl,
    toolsPath: host.toolsPath ?? "",
    capacity: host.capacity,
    online: host.online,
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.admin.patchHost(host.id, {
        name: form.name,
        kind,
        hostname: form.hostname,
        port: form.port,
        sshUser: form.sshUser,
        remoteBase: form.remoteBase,
        downloadsBase: form.downloadsBase,
        downloadsBaseUrl: form.downloadsBaseUrl,
        toolsPath: form.toolsPath || null,
        capacity: form.capacity,
        // Blank means "keep what's stored". `online` stays out of the patch —
        // the row menu owns that toggle.
        ...(form.sshKey ? { sshKey: form.sshKey } : {}),
        ...(kind === "mac" && form.artifactKey ? { artifactKey: form.artifactKey } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "hosts"] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="admin-host-dialog"
        aria-describedby={undefined}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div>
            <DialogTitle>Edit build host</DialogTitle>
          </div>
        </DialogHeader>
        <DialogBody>
          <HostFields
            mode="edit"
            kind={kind}
            onKind={setKind}
            form={form}
            setForm={setForm}
            hasArtifactKey={host.hasArtifactKey}
          />
          {error && <p className="text-error">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <div className="admin-host-dialog__tools">
            <Button variant="outline" onClick={openTest} disabled={test.isPending}>
              Test Connect
            </Button>
            {kind === "mac" && (
              <Button variant="outline" onClick={() => setSetupOpen(true)}>
                Server Setup
              </Button>
            )}
          </div>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            loading={save.isPending}
            disabled={!form.name || !form.hostname || !form.sshUser}
          >
            Save
          </Button>
        </DialogFooter>
        <TestConnectionDialog
          open={testOpen}
          onOpenChange={setTestOpen}
          hostName={host.name}
          isPending={test.isPending}
          error={test.error as Error | null}
          result={test.data ?? null}
        />
        {setupOpen && (
          <ServerSetupDialog
            hostId={host.id}
            hostName={host.name}
            onClose={() => setSetupOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// The host field set, shared by the "New build host" card and the edit dialog.
// In edit mode the kind buttons only switch the kind — they don't re-apply the
// path defaults, which would clobber whatever the host is actually configured
// with — and the key fields become optional.
/**
 * The Unix/Mac switch. Built on the shared Tabs primitive rather than a pair of
 * buttons so the two read as one connected control — it picks which *shape* of
 * host you're describing, not a value among the fields below it.
 */
function KindToggle({ kind, onKind }: { kind: Kind; onKind: (kind: Kind) => void }) {
  return (
    <Tabs value={kind} onValueChange={(v) => onKind(v as Kind)}>
      <TabsList>
        <TabsTrigger value="linux_docker">Unix</TabsTrigger>
        <TabsTrigger value="mac">Mac</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function HostFields({
  mode,
  form,
  setForm,
  hasArtifactKey,
  kind,
  onKind,
}: {
  mode: "create" | "edit";
  form: HostForm;
  setForm: (form: HostForm) => void;
  /** Drives the "already uploaded" note on the artifact key field. */
  hasArtifactKey?: boolean;
  kind: Kind;
  onKind: (kind: Kind) => void;
}) {
  const editing = mode === "edit";
  return (
    <>
      <KindToggle kind={kind} onKind={onKind} />
      <hr className="admin-host-form__rule" />
      <div className="plan-card__fields">
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
      <KeyField
        label="Private SSH key (PEM)"
        info={<SshKeyInfo />}
        // An existing DB host always has one — it's required to create the row,
        // and the key is never sent back to the browser.
        hasStoredKey={editing}
        storedNote="A key was uploaded previously and is stored encrypted. Add or upload a new one only to replace it."
        value={form.sshKey}
        onChange={(v) => setForm({ ...form, sshKey: v })}
      />
      {kind === "mac" && (
        <>
          <hr className="admin-host-form__rule" />
          <KeyField
            label="Artifact-server SSH key (Mac → Linux)"
            info={<ArtifactKeyInfo />}
            hasStoredKey={!!hasArtifactKey}
            storedNote="A key was uploaded previously and is stored encrypted. Replacing it here only updates the stored copy — use “Re-push artifact key” to write it to the Mac."
            hint={
              editing || hasArtifactKey
                ? undefined
                : "Required — pushed to the Mac at ~/.ssh/raidx_linux_key so it can scp build artifacts to the Linux downloads host. Without it, iOS builds will succeed locally but fail at the artifact-upload step."
            }
            value={form.artifactKey}
            onChange={(v) => setForm({ ...form, artifactKey: v })}
          />
        </>
      )}
    </>
  );
}

function Field({
  label,
  hint,
  info,
  actions,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  /** Optional "how do I create this?" panel, toggled by an Info button that sits
   *  immediately after the label. */
  info?: React.ReactNode;
  /** Controls for the field, right-aligned on the label row. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [showInfo, setShowInfo] = useState(false);
  return (
    <div className="plan-card__field">
      {info || actions ? (
        // Info hugs the label; the field's own controls take the right edge, so
        // a field with buttons costs one row instead of two.
        <div className="plan-card__field-label-row">
          <span className="plan-card__field-label-main">
            <Label className="plan-card__field-label">{label}</Label>
            {info && (
              <button
                type="button"
                className="field-info-btn"
                onClick={() => setShowInfo((v) => !v)}
                aria-expanded={showInfo}
                aria-label={`How to create: ${label}`}
              >
                <Info size={13} aria-hidden />
                Info
              </button>
            )}
          </span>
          {actions && <span className="plan-card__field-actions">{actions}</span>}
        </div>
      ) : (
        <Label className="plan-card__field-label">{label}</Label>
      )}
      {hint && <p className="plan-card__field-hint">{hint}</p>}
      {info && (
        <Collapse open={showInfo} className="collapse--field-gap">
          <div className="field-info-box">{info}</div>
        </Collapse>
      )}
      {children}
    </div>
  );
}

// "How do I create one?" panels for the two key fields. Kept as components so
// the instructions live next to the fields they explain.
function SshKeyInfo() {
  return (
    <>
      <p>
        {APP_NAME} uses this <strong>private</strong> key to SSH into the build host. Create a
        dedicated key pair on any machine:
      </p>
      <pre>{`ssh-keygen -t ed25519 -N "" -C "mobileflow-build" -f mobileflow_build`}</pre>
      <p>Authorize the public half on the build host (run on the host):</p>
      <pre>{`mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat mobileflow_build.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys`}</pre>
      <p>
        Then paste the contents of the private file (<code>mobileflow_build</code> — the one
        without <code>.pub</code>) here. It is stored encrypted and never displayed again.
      </p>
    </>
  );
}

function ArtifactKeyInfo() {
  return (
    <>
      <p>
        The Mac uses this key to <code>scp</code> finished build artifacts to the Linux downloads
        host. Create a separate pair:
      </p>
      <pre>{`ssh-keygen -t ed25519 -N "" -C "raidx-artifacts" -f raidx_linux_key`}</pre>
      <p>
        Authorize the public half on the <strong>Linux</strong> host, as the user the Mac connects
        as (usually root):
      </p>
      <pre>{`cat raidx_linux_key.pub >> ~/.ssh/authorized_keys`}</pre>
      <p>
        Paste the private file here — it's stored encrypted. Then use <em>Push artifact key</em> in
        the host row menu to write it to the Mac at <code>~/.ssh/raidx_linux_key</code>.
      </p>
    </>
  );
}

/**
 * A PEM private-key field. Stored keys are never sent back to the browser, so
 * once one exists there is nothing to show — the textarea would just sit there
 * empty looking like the key had been lost. Collapse it to a one-line note and
 * only open the editor when the admin actually means to replace the key, via
 * "Add Key" (paste) or "Upload Key" (pick a file). Both live on the label row.
 *
 * Accepts `.pem` and `id_*` style files alike — most private keys have no
 * extension — so the picker deliberately sets no `accept` filter.
 */
function KeyField({
  label,
  info,
  hint,
  hasStoredKey,
  storedNote,
  value,
  onChange,
}: {
  label: string;
  info?: React.ReactNode;
  hint?: React.ReactNode;
  hasStoredKey: boolean;
  storedNote: string;
  value: string;
  onChange: (v: string) => void;
}) {
  // Open by default only when there's no key yet — a new host has to supply one.
  const [open, setOpen] = useState(!hasStoredKey);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      onChange(text);
      setOpen(true);
    };
    reader.readAsText(file);
  };

  // A pasted or picked key forces the editor open, so the value on its way to
  // the server is always visible.
  const editorOpen = open || value.length > 0;

  return (
    <Field
      label={label}
      info={info}
      hint={hint}
      actions={
        <>
          <input
            ref={fileRef}
            type="file"
            className="pem-key-input__file"
            onChange={(e) => {
              onPick(e.target.files?.[0]);
              // Allow re-picking the same file.
              e.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="outline"
            type="button"
            onClick={() => {
              if (editorOpen) {
                setFileName(null);
                onChange("");
                setOpen(false);
              } else {
                setOpen(true);
              }
            }}
          >
            {editorOpen && hasStoredKey ? "Cancel" : "Add Key"}
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={() => fileRef.current?.click()}>
            Upload Key
          </Button>
        </>
      }
    >
      {editorOpen ? (
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
          {fileName && (
            <div className="pem-key-input__actions">
              <span className="pem-key-input__filename">{fileName}</span>
            </div>
          )}
        </div>
      ) : (
        <p className="plan-card__field-hint">{storedNote}</p>
      )}
    </Field>
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
            <KeyField
              label={hasExistingKey ? "Replacement key (optional)" : "Mac → Linux private key (PEM)"}
              hasStoredKey={hasExistingKey}
              storedNote="A key was uploaded previously and is stored encrypted. Push it as is, or add/upload a new one to replace it."
              value={newKey}
              onChange={setNewKey}
            />
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
