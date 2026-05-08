import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { ApiError, api, type BuildStatus } from "../api/client";

const STATUS_CLASS: Record<string, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-primary/15 text-primary",
  success: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

export function DeploymentsPage() {
  const { appId } = useParams();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const list = useQuery({
    queryKey: ["deployments", appId],
    queryFn: () => api.listDeployments(appId!),
    enabled: !!appId,
    refetchInterval: 4000,
  });

  return (
    <div className="grid gap-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Deployments</h1>
        <Button onClick={() => setOpen((s) => !s)}>{open ? "Cancel" : "Create new deployment"}</Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Manage destinations under <Link to={`/app/${appId}/deploy/destinations`} className="underline-offset-4 hover:underline">Store destinations</Link>.
      </p>

      {open && <NewDeployCard appId={appId!} onDone={() => setOpen(false)} />}

      {list.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {list.error && <p className="text-sm text-destructive">{(list.error as ApiError).message}</p>}

      <div className="grid gap-2">
        {list.data?.map((d) => (
          <div key={d.id} className="rounded-md border bg-card p-3 flex items-center gap-3">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_CLASS[d.status] ?? "bg-muted"}`}>
              {d.status}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{d.destinationName}</div>
              <div className="text-xs text-muted-foreground">
                {d.destinationType} · build {d.buildId.slice(0, 8)} · {new Date(d.createdAt).toLocaleString()}
              </div>
            </div>
            {d.status === "failed" && d.errorMessage && (
              <span className="text-xs text-destructive truncate max-w-xs">{d.errorMessage}</span>
            )}
          </div>
        ))}
        {list.data?.length === 0 && <p className="text-sm text-muted-foreground">No deployments yet.</p>}
      </div>
    </div>
  );
}

function NewDeployCard({ appId, onDone }: { appId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const buildsQ = useQuery({ queryKey: ["builds", appId], queryFn: () => api.listBuilds(appId) });
  const destsQ = useQuery({ queryKey: ["destinations", appId], queryFn: () => api.listDestinations(appId) });

  const [buildId, setBuildId] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createDeployment(appId, { buildId, destinationId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deployments", appId] });
      onDone();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  const successfulBuilds = buildsQ.data?.filter((b) => (b.status as BuildStatus) === "success") ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create new deployment</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1.5">
          <label className="text-xs">Build</label>
          <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={buildId} onChange={(e) => setBuildId(e.target.value)}>
            <option value="">— Select a successful build —</option>
            {successfulBuilds.map((b) => (
              <option key={b.id} value={b.id}>
                {b.target} · {b.commitSha.slice(0, 7)} · {new Date(b.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs">Destination</label>
          <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
            <option value="">— Select a destination —</option>
            {destsQ.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.type})
              </option>
            ))}
          </select>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!buildId || !destinationId} loading={create.isPending}>
            Deploy
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
