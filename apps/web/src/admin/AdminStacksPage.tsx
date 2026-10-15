import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Button, Loading } from "@mobileflow/ui";
import { CheckIcon } from "../components/CheckIcon";
import { RowActionsButton, RowContextMenu, type RowAction } from "../components/RowActions";
import { clearTextSelection, isInteractiveTarget } from "../lib/rowInteractions";
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

      {q.isLoading && (
        <div className="builds-status">
          <Loading>Loading stacks…</Loading>
        </div>
      )}
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
        <div className="data-grid admin-stacks-table fade-in" role="table">
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

  // One array drives both the ⋮ button and the right-click menu, so the two
  // can't drift apart.
  const actions: RowAction[] = [
    { label: "Edit", onSelect: goToEdit },
    {
      label: "Delete",
      destructive: true,
      disabled: remove.isPending,
      onSelect: () => {
        if (
          confirm(
            `Delete stack "${stack.label}"? Refused if any historical build still references it.`,
          )
        ) {
          remove.mutate();
        }
      },
    },
  ];

  return (
    <RowContextMenu actions={actions}>
      <div
        className="data-grid__row builds-row"
        role="row"
        onDoubleClick={(e) => {
          // Ignore double-clicks that land on the ⋮ button or a link, and drop
          // the text selection the second click would otherwise leave behind.
          if (isInteractiveTarget(e.target)) return;
          clearTextSelection();
          goToEdit();
        }}
      >
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
            <CheckIcon size={24} className="status-icon is-success" aria-hidden />
          ) : (
            <span className="builds-row__deployment-empty">—</span>
          )}
        </div>
        <div role="cell" className="builds-row__menu">
          <RowActionsButton actions={actions} ariaLabel={`Actions for ${stack.label}`} />
        </div>
      </div>
    </RowContextMenu>
  );
}
