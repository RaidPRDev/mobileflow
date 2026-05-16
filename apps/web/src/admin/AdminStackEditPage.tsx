import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Combobox,
  Input,
  Label,
  Switch,
} from "@mobileflow/ui";
import { ArrowLeft } from "lucide-react";
import { ApiError, api, type BuildTarget } from "../api/client";

const PLATFORM_OPTIONS = [
  { value: "ios", label: "iOS" },
  { value: "android", label: "Android" },
  { value: "web", label: "Web" },
];

interface StackEdit {
  id: string;          // immutable on edit; editable on create
  platform: BuildTarget;
  label: string;
  image: string;
  isDefault: boolean;
  sortOrder: number;
}

const UNSAVED_MESSAGE = "You have unsaved changes. Leave this page anyway?";

const EMPTY: StackEdit = {
  id: "",
  platform: "ios",
  label: "",
  image: "",
  isDefault: false,
  sortOrder: 0,
};

export function AdminStackEditPage() {
  const { stackId } = useParams();
  const isNew = !stackId || stackId === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();

  const q = useQuery({ queryKey: ["stacks"], queryFn: () => api.listStacks(), enabled: !isNew });
  const stack = !isNew ? q.data?.find((s) => s.id === stackId) : null;

  const [edit, setEdit] = useState<StackEdit | null>(isNew ? { ...EMPTY } : null);
  const [error, setError] = useState<string | null>(null);
  const originalRef = useRef<StackEdit | null>(isNew ? { ...EMPTY } : null);

  useEffect(() => {
    if (!isNew && stack && !edit) {
      const seed: StackEdit = {
        id: stack.id,
        platform: stack.platform,
        label: stack.label,
        image: stack.image ?? "",
        isDefault: stack.isDefault,
        sortOrder: stack.sortOrder,
      };
      setEdit(seed);
      originalRef.current = seed;
    }
  }, [isNew, stack, edit]);

  const isDirty = useMemo(() => {
    if (!edit || !originalRef.current) return false;
    return JSON.stringify(edit) !== JSON.stringify(originalRef.current);
  }, [edit]);

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
      if (!edit) throw new Error("Form not ready");
      const payload = {
        platform: edit.platform,
        label: edit.label,
        image: edit.image || null,
        isDefault: edit.isDefault,
        sortOrder: edit.sortOrder,
      };
      if (isNew) {
        return api.admin.createStack({ id: edit.id, ...payload });
      }
      return api.admin.patchStack(stack!.id, payload);
    },
    onSuccess: () => {
      originalRef.current = edit;
      qc.invalidateQueries({ queryKey: ["stacks"] });
      navigate("/admin/stacks");
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  if (!isNew && q.isLoading) {
    return (
      <div className="page">
        <p className="builds-status">Loading…</p>
      </div>
    );
  }
  if (!isNew && q.error) {
    return (
      <div className="page">
        <p className="builds-status is-error">{(q.error as ApiError).message}</p>
      </div>
    );
  }
  if (!isNew && !stack) {
    return (
      <div className="page">
        <p className="builds-status is-error">Stack not found.</p>
      </div>
    );
  }
  if (!edit) return null;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <div className="page-back-row">
            <button
              type="button"
              onClick={() => tryNavigate("/admin/stacks")}
              className="page-back-link"
              aria-label="Back to stacks"
            >
              <ArrowLeft size={14} aria-hidden />
            </button>
            <span className="page-back-label">Back to stacks</span>
          </div>
          <div className="plan-card__title-block">
            <h1 className="page-title">{isNew ? "New stack" : edit.label || stack!.id}</h1>
            {!isNew && <code className="plan-card__id">{stack!.id}</code>}
          </div>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stack settings</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="plan-card__fields">
            <Field
              label="ID"
              hint={isNew ? "Lowercase identifier, e.g. ios-26 or android-debug. Immutable after creation." : "IDs are immutable. Create a new stack instead."}
            >
              <Input
                value={edit.id}
                onChange={(e) => setEdit({ ...edit, id: e.target.value.toLowerCase() })}
                disabled={!isNew}
              />
            </Field>
            <Field label="Platform">
              <Combobox
                value={edit.platform}
                onChange={(v) => setEdit({ ...edit, platform: v as BuildTarget })}
                options={PLATFORM_OPTIONS}
                ariaLabel="Platform"
              />
            </Field>
            <Field label="Display label">
              <Input
                value={edit.label}
                onChange={(e) => setEdit({ ...edit, label: e.target.value })}
              />
            </Field>
            <Field
              label="Image"
              hint="For Linux stacks this is the Docker image (e.g. raidx-android-builder:latest). For iOS, the Xcode version selected via xcode-select (e.g. xcode-25.6)."
            >
              <Input
                value={edit.image}
                onChange={(e) => setEdit({ ...edit, image: e.target.value })}
              />
            </Field>
            <Field label="Sort order">
              <Input
                type="number"
                value={edit.sortOrder}
                onChange={(e) => setEdit({ ...edit, sortOrder: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Default"
              hint="If on, this stack is pre-selected in the new-build form for its platform."
            >
              <div className="plan-card__switch-row">
                <Switch
                  checked={edit.isDefault}
                  onCheckedChange={(checked) => setEdit({ ...edit, isDefault: checked })}
                  ariaLabel="Default stack"
                />
                <Label className="plan-card__switch-label">
                  {edit.isDefault ? "Default for platform" : "Not default"}
                </Label>
              </div>
            </Field>
          </div>
          {error && <p className="text-error">{error}</p>}
          <div className="row-end">
            <Button
              variant="outline"
              onClick={() => tryNavigate("/admin/stacks")}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => save.mutate()}
              disabled={!isDirty || save.isPending || !edit.id || !edit.label}
              loading={save.isPending}
            >
              {isNew ? "Create stack" : "Save"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
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
