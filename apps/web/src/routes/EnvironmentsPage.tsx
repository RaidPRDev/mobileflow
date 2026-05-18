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
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { FieldError } from "../components/FieldError";

const MAX_PREVIEW = 10;
const SECRET_PLACEHOLDER = "********";
// Validation constants — mirror apps/api/src/routes/environments.ts.
const ENV_NAME_MAX = 80;
const ENV_KEY_MAX = 120;
const ENV_VALUE_MAX = 8192;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

interface EnvFormErrors {
  name?: string;
  rows: Record<number, { key?: string; value?: string }>;
}

/**
 * Validate the New / Edit Environment form. Returns per-field errors keyed by
 * row index so each Input can render its own message. `submitted` flips on
 * after the first save attempt; we don't show errors before that to keep the
 * empty dialog quiet on open.
 */
function validateEnvForm(
  name: string,
  rows: { key: string; value: string; isSecret: boolean; id?: string | null }[],
): EnvFormErrors {
  const errors: EnvFormErrors = { rows: {} };
  const trimmedName = name.trim();
  if (!trimmedName) errors.name = "Name is required";
  else if (trimmedName.length > ENV_NAME_MAX) errors.name = `Name must be ${ENV_NAME_MAX} characters or fewer`;

  // Track keys we've already seen so duplicate entries within the same form
  // are flagged before submission — the backend has no (env_id, key) unique
  // constraint, so without this we'd silently insert two rows.
  const keysSeen = new Map<string, number>();
  rows.forEach((row, i) => {
    const trimmedKey = row.key.trim();
    if (!trimmedKey) return; // empty rows are filtered out, not flagged
    if (trimmedKey.length > ENV_KEY_MAX) {
      errors.rows[i] = { ...errors.rows[i], key: `Key must be ${ENV_KEY_MAX} characters or fewer` };
    } else if (!ENV_KEY_RE.test(trimmedKey.toUpperCase())) {
      errors.rows[i] = { ...errors.rows[i], key: "Use SCREAMING_SNAKE_CASE (letters, digits, underscore)" };
    }
    const canonical = trimmedKey.toUpperCase();
    const prev = keysSeen.get(canonical);
    if (prev !== undefined) {
      errors.rows[i] = { ...errors.rows[i], key: `Duplicate key "${canonical}" (also on row ${prev + 1})` };
    } else {
      keysSeen.set(canonical, i);
    }
    // Don't reject the secret placeholder on edit — that's the "unchanged"
    // signal, not a real value.
    if (!(row.isSecret && row.id && row.value === SECRET_PLACEHOLDER)) {
      if (row.value.length > ENV_VALUE_MAX) {
        errors.rows[i] = { ...errors.rows[i], value: `Value must be ${ENV_VALUE_MAX} characters or fewer` };
      }
    }
  });
  return errors;
}

function hasFormErrors(e: EnvFormErrors): boolean {
  if (e.name) return true;
  for (const k of Object.keys(e.rows)) {
    const r = e.rows[Number(k)];
    if (r?.key || r?.value) return true;
  }
  return false;
}

export function EnvironmentsPage() {
  const { appId } = useParams();
  const qc = useQueryClient();

  const envsQ = useQuery({
    queryKey: ["envs", appId, "withVars"],
    queryFn: () => api.listEnvironmentsWithVars(appId!),
    enabled: !!appId,
  });

  const [openCreate, setOpenCreate] = useState(false);
  const [editing, setEditing] = useState<EnvironmentWithVars | null>(null);
  const [duplicating, setDuplicating] = useState<EnvironmentWithVars | null>(null);
  const [deleting, setDeleting] = useState<EnvironmentWithVars | null>(null);

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
                      <DropdownMenuItem destructive onSelect={() => setDeleting(env)}>
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

      {deleting && (
        <DeleteEnvironmentDialog env={deleting} onClose={() => setDeleting(null)} />
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
  const [submitted, setSubmitted] = useState(false);

  // Combine for validation so duplicate keys across the secrets/variables
  // split are flagged. The row index in `errors.rows` aligns with this
  // combined array; KvSection consumers slice the relevant half back out.
  const combined = useMemo(() => [...secrets, ...variables], [secrets, variables]);
  const errors = useMemo(() => validateEnvForm(name, combined), [name, combined]);
  const blocked = hasFormErrors(errors);

  const create = async () => {
    setSubmitted(true);
    if (blocked) {
      setError("Please fix the highlighted fields.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.createEnvironment(appId, name.trim());
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

  const showErrors = submitted;
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
              maxLength={ENV_NAME_MAX}
              placeholder="staging, production…"
              aria-invalid={showErrors && errors.name ? true : undefined}
              aria-describedby={showErrors && errors.name ? "new-env-name-error" : undefined}
            />
            {showErrors && errors.name && (
              <FieldError id="new-env-name-error">{errors.name}</FieldError>
            )}
          </div>

          <KvSection
            title="Secrets"
            description="Encrypted values available only to your build at runtime."
            rows={secrets}
            isSecret
            onChange={setSecrets}
            rowErrors={showErrors ? errors.rows : undefined}
            rowIndexBase={0}
          />
          <KvSection
            title="Variables"
            description="Values available to your builds at runtime. Use secrets (above) for sensitive data."
            rows={variables}
            isSecret={false}
            onChange={setVariables}
            rowErrors={showErrors ? errors.rows : undefined}
            rowIndexBase={secrets.length}
          />

          {error && <p className="new-env-error">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={create} loading={submitting}>
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
  const [submitted, setSubmitted] = useState(false);

  const combined = useMemo(() => [...secrets, ...variables], [secrets, variables]);
  const errors = useMemo(() => validateEnvForm(name, combined), [name, combined]);
  const blocked = hasFormErrors(errors);

  const save = async () => {
    setSubmitted(true);
    if (blocked) {
      setError("Please fix the highlighted fields.");
      return;
    }
    const trimmedName = name.trim();
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
              maxLength={ENV_NAME_MAX}
              aria-invalid={submitted && errors.name ? true : undefined}
              aria-describedby={submitted && errors.name ? "edit-env-name-error" : undefined}
            />
            {submitted && errors.name && (
              <FieldError id="edit-env-name-error">{errors.name}</FieldError>
            )}
          </div>

          <KvSection
            title="Secrets"
            description="Encrypted values available only to your build at runtime."
            rows={secrets}
            isSecret
            onChange={setSecrets}
            rowErrors={submitted ? errors.rows : undefined}
            rowIndexBase={0}
          />
          <KvSection
            title="Variables"
            description="Values available to your builds at runtime. Use secrets (above) for sensitive data."
            rows={variables}
            isSecret={false}
            onChange={setVariables}
            rowErrors={submitted ? errors.rows : undefined}
            rowIndexBase={secrets.length}
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
  rowErrors,
  rowIndexBase = 0,
}: {
  title: string;
  description: string;
  rows: FormKV[];
  isSecret: boolean;
  onChange: (rows: FormKV[]) => void;
  /**
   * Errors keyed by *global* row index in the combined secrets+variables form.
   * Pass `rowIndexBase` so this section can translate its local index `i` to
   * the global index used by the validator.
   */
  rowErrors?: Record<number, { key?: string; value?: string }>;
  rowIndexBase?: number;
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
        {rows.map((row, i) => {
          const err = rowErrors?.[rowIndexBase + i];
          return (
            <div key={i} className="new-env-kv__row">
              <div className="new-env-kv__cell">
                <Input
                  placeholder="Key"
                  value={row.key}
                  onChange={(e) => update(i, { key: e.target.value })}
                  maxLength={ENV_KEY_MAX}
                  aria-invalid={err?.key ? true : undefined}
                />
                {err?.key && <FieldError>{err.key}</FieldError>}
              </div>
              <div className="new-env-kv__cell">
                <Input
                  placeholder="Value"
                  type={isSecret ? "password" : "text"}
                  value={row.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                  aria-invalid={err?.value ? true : undefined}
                  onFocus={() => {
                    // For existing secret rows, clear the placeholder so the user
                    // can type a new value. The original is tracked via originalValue.
                    if (isSecret && row.id && row.value === SECRET_PLACEHOLDER) {
                      update(i, { value: "" });
                    }
                  }}
                />
                {err?.value && <FieldError>{err.value}</FieldError>}
              </div>
              <button
                type="button"
                className="new-env-kv__remove"
                aria-label="Remove row"
                onClick={() => remove(i)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
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

  const nameError = useMemo(() => {
    const t = name.trim();
    if (!t) return "Name is required";
    if (t.length > ENV_NAME_MAX) return `Name must be ${ENV_NAME_MAX} characters or fewer`;
    return null;
  }, [name]);

  const run = async () => {
    if (nameError) {
      setError(nameError);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const created = await api.createEnvironment(appId, name.trim());
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
              maxLength={ENV_NAME_MAX}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "dup-env-name-error" : undefined}
            />
            {nameError && <FieldError id="dup-env-name-error">{nameError}</FieldError>}
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
            disabled={!!nameError || submitting}
            loading={submitting}
          >
            Duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete confirmation ────────────────────────────────────────────────────

function DeleteEnvironmentDialog({
  env,
  onClose,
}: {
  env: EnvironmentWithVars;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.deleteEnvironment(env.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["envs", env.appId] });
      onClose();
    },
  });
  const secretCount = env.vars.filter((v) => v.isSecret).length;
  const varCount = env.vars.length - secretCount;
  const details: string[] = [];
  if (varCount > 0) details.push(`${varCount} variable${varCount === 1 ? "" : "s"} will be removed`);
  if (secretCount > 0) {
    details.push(
      `${secretCount} secret${secretCount === 1 ? "" : "s"} will be permanently destroyed and cannot be recovered`,
    );
  }
  details.push("Builds that reference this environment will lose its values");

  return (
    <ConfirmDeleteDialog
      title="Delete environment"
      itemName={env.name}
      details={details}
      error={remove.error}
      pending={remove.isPending}
      onCancel={onClose}
      onConfirm={() => remove.mutate()}
      confirmLabel="Delete environment"
    />
  );
}
