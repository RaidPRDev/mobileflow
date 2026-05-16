import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Switch } from "@mobileflow/ui";
import { ArrowLeft } from "lucide-react";
import { ApiError, api } from "../api/client";

interface PlanEdit {
  name: string;
  priceCents: number;
  maxApps: number | "";
  maxSeats: number | "";
  maxConcurrentBuilds: number | "";
  canBuild: boolean;
}

const UNSAVED_MESSAGE = "You have unsaved changes. Leave this page anyway?";

export function AdminPlanEditPage() {
  const { planId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api.admin.plans() });
  const plan = q.data?.find((p) => p.id === planId);

  const [edit, setEdit] = useState<PlanEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const originalRef = useRef<PlanEdit | null>(null);

  useEffect(() => {
    if (plan && !edit) {
      const seed: PlanEdit = {
        name: plan.name,
        priceCents: plan.priceCents,
        maxApps: plan.maxApps ?? "",
        maxSeats: plan.maxSeats ?? "",
        maxConcurrentBuilds: plan.maxConcurrentBuilds ?? "",
        canBuild: plan.canBuild,
      };
      setEdit(seed);
      originalRef.current = seed;
    }
  }, [plan, edit]);

  const isDirty = useMemo(() => {
    if (!edit || !originalRef.current) return false;
    return JSON.stringify(edit) !== JSON.stringify(originalRef.current);
  }, [edit]);

  // Browser-level navigation (refresh, close tab, external link): show the
  // native unsaved-changes prompt. Note: in-app navigation via the sidebar
  // can't be intercepted without switching to the data router — Cancel and
  // Back below use a manual confirm() instead.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = UNSAVED_MESSAGE;
      return UNSAVED_MESSAGE;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const confirmLeave = () => !isDirty || window.confirm(UNSAVED_MESSAGE);
  const tryNavigate = (to: string) => {
    if (confirmLeave()) navigate(to);
  };

  const save = useMutation({
    mutationFn: () => {
      if (!edit || !plan) throw new Error("Plan not loaded");
      return api.admin.patchPlan(plan.id, {
        name: edit.name,
        priceCents: Number(edit.priceCents) || 0,
        maxApps: edit.maxApps === "" ? null : Number(edit.maxApps),
        maxSeats: edit.maxSeats === "" ? null : Number(edit.maxSeats),
        maxConcurrentBuilds: edit.maxConcurrentBuilds === "" ? null : Number(edit.maxConcurrentBuilds),
        canBuild: edit.canBuild,
      });
    },
    onSuccess: () => {
      // Clear dirty state before navigating so the guard doesn't fire.
      originalRef.current = edit;
      qc.invalidateQueries({ queryKey: ["admin", "plans"] });
      navigate("/admin/plans");
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed"),
  });

  if (q.isLoading) {
    return (
      <div className="page">
        <p className="builds-status">Loading…</p>
      </div>
    );
  }
  if (q.error) {
    return (
      <div className="page">
        <p className="builds-status is-error">{(q.error as ApiError).message}</p>
      </div>
    );
  }
  if (!plan) {
    return (
      <div className="page">
        <p className="builds-status is-error">Plan not found.</p>
      </div>
    );
  }
  if (!edit) return null;

  const readOnly = plan.isInternal;
  const canBuildId = `plan-${plan.id}-can-build`;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="page-back-row">
            <button
              type="button"
              onClick={() => tryNavigate("/admin/plans")}
              className="page-back-link"
              aria-label="Back to plans"
            >
              <ArrowLeft size={14} aria-hidden />
            </button>
            <span className="page-back-label">Back to plans</span>
          </div>
          <div className="plan-card__title-block">
            <h1 className="page-title">{plan.name}</h1>
            <code className="plan-card__id">{plan.id}</code>
            {readOnly && <span className="plan-card__readonly">read-only</span>}
          </div>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan limits</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="plan-card__fields">
            <Field label="Name">
              <Input
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                disabled={readOnly}
              />
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
                onChange={(e) =>
                  setEdit({ ...edit, maxApps: e.target.value === "" ? "" : Number(e.target.value) })
                }
                disabled={readOnly}
              />
            </Field>
            <Field label="Max seats">
              <Input
                type="number"
                value={edit.maxSeats}
                onChange={(e) =>
                  setEdit({ ...edit, maxSeats: e.target.value === "" ? "" : Number(e.target.value) })
                }
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
              <div className="plan-card__switch-row">
                <Switch
                  id={canBuildId}
                  checked={edit.canBuild}
                  onCheckedChange={(checked) => setEdit({ ...edit, canBuild: checked })}
                  disabled={readOnly}
                  ariaLabel="Can build"
                />
                <Label htmlFor={canBuildId} className="plan-card__switch-label">
                  {edit.canBuild ? "Builds enabled" : "Builds disabled"}
                </Label>
              </div>
            </Field>
          </div>
          {error && <p className="text-error">{error}</p>}
          <div className="row-end">
            <Button variant="outline" onClick={() => tryNavigate("/admin/plans")} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => save.mutate()}
              disabled={readOnly || !isDirty || save.isPending}
              loading={save.isPending}
            >
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="plan-card__field">
      <Label className="plan-card__field-label">{label}</Label>
      {children}
    </div>
  );
}
