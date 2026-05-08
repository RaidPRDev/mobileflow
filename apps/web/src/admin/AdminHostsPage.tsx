import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

type Kind = "linux_docker" | "mac";

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

export function AdminHostsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "hosts"], queryFn: () => api.admin.hosts() });
  const [showForm, setShowForm] = useState(false);

  const remove = useMutation({
    mutationFn: (id: string) => api.admin.deleteHost(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "hosts"] }),
  });
  const setOnline = useMutation({
    mutationFn: ({ id, online }: { id: string; online: boolean }) => api.admin.patchHost(id, { online }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "hosts"] }),
  });
  const test = useMutation({
    mutationFn: (id: string) => api.admin.testHost(id),
  });

  return (
    <div className="grid gap-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Build hosts</h1>
        <Button onClick={() => setShowForm((s) => !s)}>{showForm ? "Cancel" : "Add host"}</Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Hosts here override the <code>LINUX_BUILD_*</code> / <code>MAC_BUILD_*</code> env vars. Runners pick the first online row matching their kind.
      </p>

      {showForm && <NewHostCard onDone={() => setShowForm(false)} />}

      <div className="grid gap-2">
        {q.data?.map((h) => (
          <Card key={h.id}>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                {h.name}
                <span className={`text-xs uppercase rounded-full px-2 py-0.5 ${h.online ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground"}`}>
                  {h.online ? "online" : "offline"}
                </span>
                <span className="text-xs uppercase rounded-full px-2 py-0.5 bg-muted">{h.kind}</span>
              </CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => test.mutate(h.id)} loading={test.isPending}>
                  Test
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOnline.mutate({ id: h.id, online: !h.online })}>
                  {h.online ? "Mark offline" : "Mark online"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (confirm(`Delete host "${h.name}"?`)) remove.mutate(h.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </CardHeader>
            <CardContent className="text-sm grid gap-1 text-muted-foreground">
              <div>
                <code>{h.sshUser}@{h.hostname}:{h.port}</code> · capacity {h.capacity}
              </div>
              <div>remote: <code>{h.remoteBase}</code></div>
              <div>downloads: <code>{h.downloadsBase}</code> → {h.downloadsBaseUrl}</div>
              {h.toolsPath && <div>tools: <code>{h.toolsPath}</code></div>}
              {test.data && test.variables === h.id && (
                <pre className="rounded-md border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
                  {test.data.ok ? `OK\n${test.data.output ?? ""}` : `FAIL\n${test.data.error ?? ""}`}
                </pre>
              )}
            </CardContent>
          </Card>
        ))}
        {q.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No hosts configured. Falling back to env vars when present.</p>
        )}
      </div>
    </div>
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
      <CardContent className="grid gap-3">
        <div className="flex gap-2">
          <Button size="sm" variant={kind === "linux_docker" ? "default" : "outline"} onClick={() => onKind("linux_docker")}>
            Linux (Docker)
          </Button>
          <Button size="sm" variant={kind === "mac" ? "default" : "outline"} onClick={() => onKind("mac")}>
            Mac (NoMachine / native)
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
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
          <Field label="Capacity">
            <Input type="number" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Private SSH key (PEM)">
          <textarea
            className="h-40 rounded-md border border-input bg-background p-2 text-xs font-mono"
            value={form.sshKey}
            onChange={(e) => setForm({ ...form, sshKey: e.target.value })}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
          />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name || !form.hostname || !form.sshUser || !form.sshKey}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
