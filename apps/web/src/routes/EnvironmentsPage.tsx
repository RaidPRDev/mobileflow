import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

export function EnvironmentsPage() {
  const { appId } = useParams();
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");

  const envsQ = useQuery({
    queryKey: ["envs", appId],
    queryFn: () => api.listEnvironments(appId!),
    enabled: !!appId,
  });

  const create = useMutation({
    mutationFn: (name: string) => api.createEnvironment(appId!, name),
    onSuccess: () => {
      setNewName("");
      qc.invalidateQueries({ queryKey: ["envs", appId] });
    },
  });

  const remove = useMutation({
    mutationFn: (envId: string) => api.deleteEnvironment(envId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envs", appId] }),
  });

  return (
    <div className="max-w-3xl grid gap-4">
      <h1 className="text-2xl font-semibold">Environments</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New environment</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-2 items-end">
          <div className="grid gap-1.5 flex-1">
            <Label htmlFor="env-name">Name</Label>
            <Input id="env-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="staging, production…" />
          </div>
          <Button onClick={() => create.mutate(newName.trim())} disabled={!newName.trim() || create.isPending} loading={create.isPending}>
            Create
          </Button>
        </CardContent>
      </Card>

      {envsQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {envsQ.error && <p className="text-sm text-destructive">{(envsQ.error as ApiError).message}</p>}

      {envsQ.data?.map((env) => <EnvCard key={env.id} envId={env.id} name={env.name} onDelete={() => remove.mutate(env.id)} />)}
    </div>
  );
}

function EnvCard({ envId, name, onDelete }: { envId: string; name: string; onDelete: () => void }) {
  const qc = useQueryClient();
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  const [secret, setSecret] = useState(false);

  const varsQ = useQuery({
    queryKey: ["env-vars", envId],
    queryFn: () => api.listEnvVars(envId),
  });

  const addVar = useMutation({
    mutationFn: () => api.createEnvVar(envId, { key: k.trim(), value: v, isSecret: secret }),
    onSuccess: () => {
      setK("");
      setV("");
      setSecret(false);
      qc.invalidateQueries({ queryKey: ["env-vars", envId] });
    },
  });
  const delVar = useMutation({
    mutationFn: (id: string) => api.deleteEnvVar(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["env-vars", envId] }),
  });

  return (
    <Card>
      <CardHeader className="flex-row justify-between items-center">
        <CardTitle className="text-base">{name}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          Delete
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2">
          {varsQ.data?.map((row) => (
            <div key={row.id} className="flex items-center gap-2 text-sm">
              <code className="font-mono">{row.key}</code>
              <span className="text-muted-foreground flex-1 truncate">{row.value}</span>
              {row.isSecret && <span className="text-xs uppercase text-muted-foreground">secret</span>}
              <Button size="sm" variant="ghost" onClick={() => delVar.mutate(row.id)}>
                Remove
              </Button>
            </div>
          ))}
          {varsQ.data?.length === 0 && <p className="text-xs text-muted-foreground">No variables yet.</p>}
        </div>
        <div className="grid grid-cols-[1fr,1fr,auto,auto] gap-2 items-end pt-2 border-t">
          <div className="grid gap-1">
            <Label htmlFor={`k-${envId}`} className="text-xs">Key</Label>
            <Input id={`k-${envId}`} value={k} onChange={(e) => setK(e.target.value.toUpperCase())} placeholder="API_BASE_URL" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`v-${envId}`} className="text-xs">Value</Label>
            <Input id={`v-${envId}`} value={v} onChange={(e) => setV(e.target.value)} type={secret ? "password" : "text"} />
          </div>
          <label className="text-xs flex items-center gap-1 mb-2">
            <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} />
            secret
          </label>
          <Button onClick={() => addVar.mutate()} disabled={!k.trim() || !v || addVar.isPending} loading={addVar.isPending}>
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
