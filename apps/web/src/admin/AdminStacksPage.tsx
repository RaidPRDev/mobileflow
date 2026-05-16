import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "@mobileflow/ui";
import { CheckCircle2 } from "lucide-react";
import { ApiError, api, type BuildTarget } from "../api/client";

interface Stack {
  id: string;
  platform: BuildTarget;
  label: string;
  image: string | null;
  isDefault: boolean;
  sortOrder: number;
}

const PLATFORM_LABEL: Record<BuildTarget, string> = {
  ios: "iOS",
  android: "Android",
  web: "Web",
};

export function AdminStacksPage() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["stacks"], queryFn: () => api.listStacks() });

  const stacks = q.data ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">Build stacks</h1>
        </div>
        <Button onClick={() => navigate("/admin/stacks/new")}>New stack</Button>
      </header>
      <p className="page-subtitle">
        Tooling identifiers attached to each build. Linux stacks (Android, Web) run on any
        available Linux host; iOS stacks require a Mac with the matching Xcode installed.
      </p>

      {q.isLoading && <div className="builds-status">Loading stacks…</div>}
      {q.error && (
        <div className="builds-status is-error">{(q.error as ApiError).message}</div>
      )}

      {!q.isLoading && stacks.length === 0 && (
        <div className="empty-state">
          <h2 className="empty-state__title">No stacks</h2>
          <p className="empty-state__body">Add one above to start running builds.</p>
        </div>
      )}

      {!!stacks.length && (
        <div className="data-grid admin-stacks-table" role="table">
          <div className="data-grid__head" role="row">
            <span role="columnheader">Stack</span>
            <span role="columnheader">Platform</span>
            <span role="columnheader">Image</span>
            <span role="columnheader">Default</span>
            <span role="columnheader" aria-label="Actions"></span>
          </div>
          {stacks.map((s) => (
            <StackRow key={s.id} stack={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function StackRow({ stack }: { stack: Stack }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const goToEdit = () => navigate(`/admin/stacks/${stack.id}`);

  const remove = useMutation({
    mutationFn: () => api.admin.deleteStack(stack.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stacks"] }),
    onError: (err) => alert(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <div className="data-grid__row builds-row is-clickable" role="row" onClick={goToEdit}>
      <div role="cell">
        <div className="plan-card__title-block">
          <span className="builds-row__triggered-name">{stack.label}</span>
          <code className="plan-card__id">{stack.id}</code>
        </div>
      </div>
      <div role="cell">
        <span className="builds-row__platform-label">{PLATFORM_LABEL[stack.platform]}</span>
      </div>
      <div role="cell" className="admin-hosts-row__addr">
        {stack.image ?? "—"}
      </div>
      <div role="cell" className="builds-row__status">
        {stack.isDefault ? (
          <CheckCircle2 size={18} className="status-icon is-success" aria-hidden />
        ) : (
          <span className="builds-row__deployment-empty">—</span>
        )}
      </div>
      <div role="cell" className="builds-row__menu" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton variant="menu" aria-label={`Actions for ${stack.label}`} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={goToEdit}>Edit</DropdownMenuItem>
            <DropdownMenuItem
              destructive
              disabled={remove.isPending}
              onSelect={() => {
                if (
                  confirm(
                    `Delete stack "${stack.label}"? Refused if any historical build still references it.`,
                  )
                ) {
                  remove.mutate();
                }
              }}
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
