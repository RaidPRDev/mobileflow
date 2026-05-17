import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "@mobileflow/ui";
import { ChevronDown } from "lucide-react";
import { RUNTIME_LABEL } from "@mobileflow/shared";
import { ApiError, AppRow, api } from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";

export function AppsPage() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<AppRow | null>(null);

  const { data: apps, isLoading, error } = useQuery({
    queryKey: ["apps", orgId],
    queryFn: () => api.listApps(orgId!),
    enabled: !!orgId,
  });

  const remove = useMutation({
    mutationFn: (appId: string) => api.deleteApp(appId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps", orgId] });
      setPendingDelete(null);
    },
  });

  return (
    <div className="apps-page">
      <header className="apps-page__header">
        <h1 className="page-title">Apps</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              New app
              <ChevronDown size={14} style={{ marginLeft: 4 }} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled>Create from template</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate(`/org/${orgId}/apps/import`)}>
              Import app
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {isLoading && <p className="apps-page__status">Loading…</p>}
      {error && <p className="apps-page__status is-danger">{(error as ApiError).message}</p>}

      {apps && apps.length === 0 && (
        <div className="apps-empty">
          <div className="apps-empty__title">No apps yet</div>
          <p className="apps-empty__desc">Import a repository to start building.</p>
          <Button asChild>
            <Link to={`/org/${orgId}/apps/import`}>Import app</Link>
          </Button>
        </div>
      )}

      {apps && apps.length > 0 && (
        <ul className="apps-list">
          {apps.map((app) => (
            <AppListItem
              key={app.id}
              app={app}
              onDelete={() => setPendingDelete(app)}
            />
          ))}
        </ul>
      )}

      {apps && apps.length > 0 && (
        <div className="apps-page__pagination">
          <Button variant="outline" size="sm" disabled>Previous</Button>
          <Button variant="outline" size="sm" disabled>Next</Button>
        </div>
      )}

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete app?</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>{pendingDelete?.name}</strong> and all of its
              builds, environments, and deployments. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {remove.error && (
            <p className="apps-page__status is-danger">{(remove.error as ApiError).message}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDelete(null)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && remove.mutate(pendingDelete.id)}
              loading={remove.isPending}
              disabled={remove.isPending}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AppListItem({ app, onDelete }: { app: AppRow; onDelete: () => void }) {
  const navigate = useNavigate();
  const runtime = RUNTIME_LABEL[app.runtime] ?? app.runtime;
  const shortId = app.id.slice(0, 8);
  const updated = relativeTime(app.createdAt);
  const updatedFull = formatFullDate(app.createdAt);

  return (
    <li className="apps-list__item">
      <Link to={`/app/${app.id}/commits`} className="apps-list__link">
        <AppIcon app={app} />
        <div className="apps-list__meta">
          <div className="apps-list__name">{app.name}</div>
          <div className="apps-list__sub">
            <span>{runtime}</span>
            <span className="apps-list__dot">·</span>
            <span className="apps-list__id">{shortId}</span>
            <span className="apps-list__dot">·</span>
            {!app.gitRepoFullName && (
              <>
                <span className="apps-list__badge apps-list__badge--warn">No repo connected</span>
                <span className="apps-list__dot">·</span>
              </>
            )}
            <span className="tooltip-wrap" tabIndex={0}>
              Last updated {updated}
              <span className="tooltip-bubble" role="tooltip">{updatedFull}</span>
            </span>
          </div>
        </div>
      </Link>
      <div className="apps-list__actions">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton variant="menu" aria-label={`Actions for ${app.name}`} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => navigate(`/app/${app.id}/commits`)}>
              View app
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate(`/app/${app.id}/settings/general`)}>
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={onDelete}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function AppIcon({ app }: { app: AppRow }) {
  if (app.iconUrl) {
    return <img src={app.iconUrl} alt="" className="apps-list__icon apps-list__icon--img" />;
  }
  const { hue, letter } = iconSeed(app);
  const style = {
    background: `linear-gradient(135deg, hsl(${hue}, 70%, 78%) 0%, hsl(${(hue + 30) % 360}, 65%, 60%) 100%)`,
  };
  return (
    <div className="apps-list__icon" style={style} aria-hidden="true">
      <span className="apps-list__icon-letter">{letter}</span>
    </div>
  );
}

function iconSeed(app: AppRow) {
  const seed = app.id || app.name;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return {
    hue: h % 360,
    letter: (app.name.trim()[0] ?? "?").toUpperCase(),
  };
}

