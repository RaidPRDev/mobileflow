import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreVertical, Plus, Trash2 } from "lucide-react";
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
} from "@mobileflow/ui";
import { ApiError, api, type EnvVarRow, type EnvironmentWithVars } from "../api/client";

const MAX_PREVIEW = 10;
const SECRET_PLACEHOLDER = "********";

export function EnvironmentsPage() {
  const { appId } = useParams();
  const qc = useQueryClient();

  const envsQ = useQuery({
    queryKey: ["envs", appId, "withVars"],
    queryFn: () => api.listEnvironmentsWithVars(appId!),
    enabled: !!appId,
  });

  const remove = useMutation({
    mutationFn: (envId: string) => api.deleteEnvironment(envId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envs", appId] }),
  });

  const [openCreate, setOpenCreate] = useState(false);
  const [editing, setEditing] = useState<EnvironmentWithVars | null>(null);
  const [duplicating, setDuplicating] = useState<EnvironmentWithVars | null>(null);

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Environments</h1>
        <div className="page-actions">
          <Button onClick={() => setOpenCreate(true)}>New environment</Button>
        </div>
      </div>

      {envsQ.isLoading && <p className="text-help">Loading…</p>}
      {envsQ.error && <p className="text-error">{(envsQ.error as ApiError).message}</p>}

      {!!envsQ.data?.length && (
        <div className="data-grid envs-table" role="table">
          <div className="data-grid__head" role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Secrets</span>
            <span role="columnheader">Variables</span>
            <span role="columnheader" aria-label="Actions"></span>
          </div>
          {envsQ.data.map((env) => {
            const secrets = env.vars.filter((v) => v.isSecret);
            const variables = env.vars.filter((v) => !v.isSecret);
            return (
              <div key={env.id} className="data-grid__row envs-row" role="row">
                <div role="cell">
                  <div className="data-row-name">{env.name}</div>
                </div>
                <div role="cell">
                  <KvPreview rows={secrets} />
                </div>
                <div role="cell">
                  <KvPreview rows={variables} />
                </div>
                <div role="cell" className="data-grid__actions">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton variant="menu" aria-label="More actions">
                        <MoreVertical size={16} />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => setEditing(env)}>Edit</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDuplicating(env)}>Duplicate</DropdownMenuItem>
                      <DropdownMenuItem destructive onSelect={() => remove.mutate(env.id)}>
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {envsQ.data?.length === 0 && (
        <div className="empty-state">
          <h2 className="empty-state__title">No environments yet</h2>
          <p className="empty-state__body">Group variables and secrets together for your builds.</p>
          <Button onClick={() => setOpenCreate(true)}>New environment</Button>
        </div>
      )}

      {openCreate && appId && (
        <NewEnvironmentDialog appId={appId} onClose={() => setOpenCreate(false)} />
      )}

      {editing && (
        <EditEnvironmentDialog env={editing} onClose={() => setEditing(null)} />
      )}

      {duplicating && appId && (
        <DuplicateEnvironmentDialog appId={appId} source={duplicating} onClose={() => setDuplicating(null)} />
      )}
    </div>
  );
}

function KvPreview({ rows }: { rows: EnvVarRow[] }) {
  if (rows.length === 0) return <span className="env-empty">--</span>;
  const shown = rows.slice(0, MAX_PREVIEW);
  return (
    <div className="env-kv-mini">
      {shown.map((r) => (
        <div className="env-kv-mini__row" key={r.id}>
          <code className="env-kv-mini__key">{r.key}</code>
          <code className="env-kv-mini__val">{r.value}</code>
        </div>
      ))}
      {rows.length > MAX_PREVIEW && (
        <div className="env-kv-mini__more">+{rows.length - MAX_PREVIEW} more</div>
      )}
    </div>
  );
}

// ─── New Environment (name + secrets + variables) ───────────────────────────

function NewEnvironmentDialog({ appId, onClose }: { appId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [secrets, setSecrets] = useState<FormKV[]>([blankRow(true)]);
  const [variables, setVariables] = useState<FormKV[]>([blankRow(false)]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.createEnvironment(appId, trimmedName);
      // Filter out blank rows. Keys are uppercased to match the Edit dialog.
      const all = [...secrets, ...variables].filter((r) => r.key.trim());
      for (const row of all) {
        await api.createEnvVar(created.id, {
          key: row.key.trim().toUpperCase(),
          value: row.value,
          isSecret: row.isSecret,
        });
      }
      qc.invalidateQueries({ queryKey: ["envs", appId] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="new-env-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New Environment</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="new-env-field">
            <Label htmlFor="new-env-name">Name</Label>
            <Input
              id="new-env-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="staging, production…"
            />
          </div>

          <KvSection
            title="Secrets"
            description="Encrypted values available only to your build at runtime."
            rows={secrets}
            isSecret
            onChange={setSecrets}
          />
          <KvSection
            title="Variables"
            description="Values available to your builds at runtime. Use secrets (above) for sensitive data."
            rows={variables}
            isSecret={false}
            onChange={setVariables}
          />

          {error && <p className="new-env-error">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={create}
            disabled={!name.trim() || submitting}
            loading={submitting}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit Environment (full layout: name + secrets + variables) ──────────────

interface FormKV {
  // For existing rows, id holds the DB id; new rows have id = null.
  id: string | null;
  key: string;
  value: string;
  isSecret: boolean;
  // For secret rows: the value field starts as the placeholder. We only treat
  // it as "changed" when the user actually types something different.
  originalValue: string;
}

function toFormRows(env: EnvironmentWithVars): { secrets: FormKV[]; variables: FormKV[] } {
  const secrets: FormKV[] = [];
  const variables: FormKV[] = [];
  for (const v of env.vars) {
    const row: FormKV = {
      id: v.id,
      key: v.key,
      value: v.value,
      isSecret: v.isSecret,
      originalValue: v.value,
    };
    if (v.isSecret) secrets.push(row);
    else variables.push(row);
  }
  return { secrets, variables };
}

function blankRow(isSecret: boolean): FormKV {
  return { id: null, key: "", value: "", isSecret, originalValue: "" };
}

function EditEnvironmentDialog({ env, onClose }: { env: EnvironmentWithVars; onClose: () => void }) {
  const qc = useQueryClient();
  const initial = useMemo(() => toFormRows(env), [env]);
  const [name, setName] = useState(env.name);
  const [secrets, setSecrets] = useState<FormKV[]>(initial.secrets.length ? initial.secrets : [blankRow(true)]);
  const [variables, setVariables] = useState<FormKV[]>(initial.variables.length ? initial.variables : [blankRow(false)]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // 1. Name
      if (trimmedName !== env.name) {
        await api.updateEnvironment(env.id, { name: trimmedName });
      }

      // 2. Diff vars: delete removed, create new/changed.
      const submitted = [...secrets, ...variables].filter((r) => r.key.trim());
      const submittedExistingIds = new Set(submitted.filter((r) => r.id).map((r) => r.id!));

      // Deletes: existing rows the user removed entirely.
      const allOriginalIds = env.vars.map((v) => v.id);
      const toDelete = allOriginalIds.filter((id) => !submittedExistingIds.has(id));
      for (const id of toDelete) {
        await api.deleteEnvVar(id);
      }

      for (const row of submitted) {
        const trimmedKey = row.key.trim().toUpperCase();
        // Secret rows whose value is still the placeholder are unchanged — skip.
        if (row.isSecret && row.id && row.value === SECRET_PLACEHOLDER) {
          // But: maybe the user renamed the key. If yes, we need to replace.
          const original = env.vars.find((v) => v.id === row.id);
          if (original && original.key === trimmedKey) continue;
          // key changed — recreate (no value-only PATCH endpoint exists).
          await api.deleteEnvVar(row.id);
          await api.createEnvVar(env.id, { key: trimmedKey, value: original?.value ?? "", isSecret: true });
          continue;
        }
        if (row.id) {
          const original = env.vars.find((v) => v.id === row.id);
          if (original && original.key === trimmedKey && original.value === row.value && original.isSecret === row.isSecret) {
            continue; // truly unchanged
          }
          await api.deleteEnvVar(row.id);
          await api.createEnvVar(env.id, { key: trimmedKey, value: row.value, isSecret: row.isSecret });
        } else {
          await api.createEnvVar(env.id, { key: trimmedKey, value: row.value, isSecret: row.isSecret });
        }
      }

      qc.invalidateQueries({ queryKey: ["envs"] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="new-env-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Edit Environment</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="new-env-field">
            <Label htmlFor="edit-env-name">Name</Label>
            <Input
              id="edit-env-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <KvSection
            title="Secrets"
            description="Encrypted values available only to your build at runtime."
            rows={secrets}
            isSecret
            onChange={setSecrets}
          />
          <KvSection
            title="Variables"
            description="Values available to your builds at runtime. Use secrets (above) for sensitive data."
            rows={variables}
            isSecret={false}
            onChange={setVariables}
          />

          {error && <p className="new-env-error">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={save} loading={submitting}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KvSection({
  title,
  description,
  rows,
  isSecret,
  onChange,
}: {
  title: string;
  description: string;
  rows: FormKV[];
  isSecret: boolean;
  onChange: (rows: FormKV[]) => void;
}) {
  const update = (i: number, patch: Partial<FormKV>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) =>
    onChange(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [blankRow(isSecret)]);
  const add = () => onChange([...rows, blankRow(isSecret)]);

  return (
    <div className="new-env-section">
      <div className="new-env-section__title">{title}</div>
      <p className="new-env-section__desc">{description}</p>
      <div className="new-env-kv">
        <div className="new-env-kv__head">
          <span>KEY</span>
          <span>VALUE</span>
          <span></span>
        </div>
        {rows.map((row, i) => (
          <div key={i} className="new-env-kv__row">
            <Input
              placeholder="Key"
              value={row.key}
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <Input
              placeholder="Value"
              type={isSecret ? "password" : "text"}
              value={row.value}
              onChange={(e) => update(i, { value: e.target.value })}
              onFocus={() => {
                // For existing secret rows, clear the placeholder so the user
                // can type a new value. The original is tracked via originalValue.
                if (isSecret && row.id && row.value === SECRET_PLACEHOLDER) {
                  update(i, { value: "" });
                }
              }}
            />
            <button
              type="button"
              className="new-env-kv__remove"
              aria-label="Remove row"
              onClick={() => remove(i)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="new-build-link-button" onClick={add}>
          <Plus size={12} /> Add another
        </button>
      </div>
    </div>
  );
}

// ─── Duplicate (create new env + copy non-secret vars) ──────────────────────

function DuplicateEnvironmentDialog({
  appId,
  source,
  onClose,
}: {
  appId: string;
  source: EnvironmentWithVars;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(`${source.name} (copy)`);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(`${source.name} (copy)`);
  }, [source.name]);

  const run = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.createEnvironment(appId, trimmed);
      // Copy non-secret vars verbatim. Secrets can't be duplicated because the
      // server only returns a placeholder for them — we surface a note below.
      for (const v of source.vars) {
        if (v.isSecret) continue;
        await api.createEnvVar(created.id, { key: v.key, value: v.value, isSecret: false });
      }
      qc.invalidateQueries({ queryKey: ["envs", appId] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const hasSecrets = source.vars.some((v) => v.isSecret);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="new-env-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Duplicate Environment</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="new-env-field">
            <Label htmlFor="dup-env-name">Name</Label>
            <Input
              id="dup-env-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <p className="text-help">
            Variables will be copied. {hasSecrets && "Secrets will not be copied — re-enter them on the new environment."}
          </p>
          {error && <p className="new-env-error">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={run}
            disabled={!name.trim() || submitting}
            loading={submitting}
          >
            Duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
