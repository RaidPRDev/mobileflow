import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

export function AdminPlansPage() {
  const q = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api.admin.plans() });

  return (
    <div className="grid gap-4 max-w-5xl">
      <h1 className="text-2xl font-semibold">Plans</h1>
      <p className="text-sm text-muted-foreground">
        The <code>unlimited</code> plan is read-only and assignable only via the org detail page.
      </p>
      <div className="grid gap-3">{q.data?.map((p) => <PlanCard key={p.id} plan={p} />)}</div>
    </div>
  );
}

interface Plan {
  id: string;
  name: string;
  priceCents: number;
  maxApps: number | null;
  maxSeats: number | null;
  maxConcurrentBuilds: number | null;
  canBuild: boolean;
  isInternal: boolean;
}

function PlanCard({ plan }: { plan: Plan }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState({
    name: plan.name,
    priceCents: plan.priceCents,
    maxApps: plan.maxApps ?? "",
    maxSeats: plan.maxSeats ?? "",
    maxConcurrentBuilds: plan.maxConcurrentBuilds ?? "",
    canBuild: plan.canBuild,
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.admin.patchPlan(plan.id, {
        name: edit.name,
        priceCents: Number(edit.priceCents) || 0,
        maxApps: edit.maxApps === "" ? null : Number(edit.maxApps),
        maxSeats: edit.maxSeats === "" ? null : Number(edit.maxSeats),
        maxConcurrentBuilds: edit.maxConcurrentBuilds === "" ? null : Number(edit.maxConcurrentBuilds),
        canBuild: edit.canBuild,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "plans"] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed"),
  });

  const readOnly = plan.isInternal;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">
          {plan.name} <code className="text-xs text-muted-foreground ml-1">{plan.id}</code>
        </CardTitle>
        {readOnly && <span className="text-xs text-muted-foreground uppercase">read-only</span>}
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} disabled={readOnly} />
          </Field>
          <Field label="Price (cents)">
            <Input
              type="number"
              value={edit.priceCents}
              onChange={(e) => setEdit({ ...edit, priceCents: Number(e.target.value) })}
              disabled={readOnly}
            />
          </Field>
          <Field label="Max apps (blank = unlimited)">
            <Input
              type="number"
              value={edit.maxApps}
              onChange={(e) => setEdit({ ...edit, maxApps: e.target.value === "" ? "" : Number(e.target.value) })}
              disabled={readOnly}
            />
          </Field>
          <Field label="Max seats">
            <Input
              type="number"
              value={edit.maxSeats}
              onChange={(e) => setEdit({ ...edit, maxSeats: e.target.value === "" ? "" : Number(e.target.value) })}
              disabled={readOnly}
            />
          </Field>
          <Field label="Max concurrent builds">
            <Input
              type="number"
              value={edit.maxConcurrentBuilds}
              onChange={(e) =>
                setEdit({ ...edit, maxConcurrentBuilds: e.target.value === "" ? "" : Number(e.target.value) })
              }
              disabled={readOnly}
            />
          </Field>
          <Field label="Can build">
            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={edit.canBuild}
                onChange={(e) => setEdit({ ...edit, canBuild: e.target.checked })}
                disabled={readOnly}
              />
              enabled
            </label>
          </Field>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={readOnly || save.isPending} loading={save.isPending}>
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
