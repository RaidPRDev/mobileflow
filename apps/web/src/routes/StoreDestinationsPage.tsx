import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreVertical } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "@mobileflow/ui";
import appleIcon from "@assets/icons/apple-icon.svg";
import androidIcon from "@assets/icons/android-icon.svg";
import appStoreIcon from "@assets/icons/app-store-icon.svg";
import googlePlayIcon from "@assets/icons/google-playstore-icon.svg";
import {
  ApiError,
  api,
  type BuildTarget,
  type DeploymentRow,
  type DestinationRow,
  type DestinationType,
} from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";
import { useAdaptivePageSize } from "../lib/useAdaptivePageSize";
import { ListFooter } from "../components/ListFooter";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import {
  StoreDestinationDialog,
  TYPE_PLATFORM,
  destIcon,
  type DestType,
} from "./StoreDestinationDialog";

const PLATFORM_ICON_BG: Record<"ios" | "android" | "web", string> = {
  ios: "#0a0a0a",
  android: "#34a853",
  web: "#f7df1e",
};

export function StoreDestinationsPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; row: DestinationRow } | null>(null);
  const [page, setPage] = useState(0);
  const [deleting, setDeleting] = useState<DestinationRow | null>(null);

  const destQ = useQuery({
    queryKey: ["destinations", appId],
    queryFn: () => api.listDestinations(appId!),
    enabled: !!appId,
  });

  // Used to derive "Latest deployment X ago" + "Deployed build #N" per row.
  const depQ = useQuery({
    queryKey: ["deployments", appId],
    queryFn: () => api.listDeployments(appId!),
    enabled: !!appId,
  });

  const latestByDest = useMemo(() => {
    const map = new Map<string, DeploymentRow>();
    for (const d of depQ.data ?? []) {
      // listDeployments returns newest-first, so the first hit per id wins.
      if (!map.has(d.destinationId)) map.set(d.destinationId, d);
    }
    return map;
  }, [depQ.data]);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDestination(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["destinations", appId] });
      setDeleting(null);
    },
  });

  const listRef = useRef<HTMLDivElement>(null);
  const pageSize = useAdaptivePageSize({
    rowHeight: 64,
    anchorRef: listRef,
    reserve: 90,
    min: 5,
    max: 25,
  });
  const all = destQ.data ?? [];
  const total = all.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageIdx = Math.min(page, pageCount - 1);
  const start = pageIdx * pageSize;
  const visible = all.slice(start, start + pageSize);

  return (
    <div className="page store-destinations-page">
      <div className="page-header">
        <h1 className="page-title">Store Destinations</h1>
        <div className="page-actions">
          <Button onClick={() => setDialog({ mode: "create" })}>New store destination</Button>
        </div>
      </div>

      {dialog && (
        <StoreDestinationDialog
          appId={appId!}
          existing={dialog.mode === "edit" ? dialog.row : undefined}
          onClose={() => setDialog(null)}
        />
      )}

      {destQ.isLoading && <div className="builds-status">Loading destinations…</div>}
      {destQ.error && (
        <div className="builds-status is-error">{(destQ.error as ApiError).message}</div>
      )}

      {!destQ.isLoading && total === 0 && (
        <div className="empty-state">
          <h2 className="empty-state__title">No destinations yet</h2>
          <p className="empty-state__body">Add a store destination to enable deployments.</p>
          <Button onClick={() => setDialog({ mode: "create" })}>New store destination</Button>
        </div>
      )}

      {total > 0 && (
        <>
          <div className="destination-list" role="list" ref={listRef}>
            {visible.map((d) => {
              const type = d.type as DestType;
              const latest = latestByDest.get(d.id) ?? null;
              return (
                <DestinationListItem
                  key={d.id}
                  destination={d}
                  type={type}
                  latest={latest}
                  onOpen={() => navigate(`/app/${appId}/deploy/store-destinations/${d.id}`)}
                  onEdit={() => setDialog({ mode: "edit", row: d })}
                  onDelete={() => setDeleting(d)}
                />
              );
            })}
          </div>

          <ListFooter
            total={total}
            pageIdx={pageIdx}
            pageCount={pageCount}
            unit="store destination"
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          />
        </>
      )}

      {deleting && (
        <ConfirmDeleteDialog
          title="Delete store destination"
          itemName={deleting.name}
          details={[
            "Stored credentials (Apple API key / .p12 / service-account JSON) will be permanently destroyed",
            "Deployment history is preserved, but new deploys to this destination will no longer be possible",
          ]}
          error={remove.error}
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
          confirmLabel="Delete destination"
        />
      )}
    </div>
  );
}

interface DestinationListItemProps {
  destination: DestinationRow;
  type: DestType;
  latest: DeploymentRow | null;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function DestinationListItem({ destination, type, latest, onOpen, onEdit, onDelete }: DestinationListItemProps) {
  const fullDate = latest ? formatFullDate(latest.createdAt) : null;
  return (
    <div
      className="destination-card"
      role="listitem"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="destination-card__icon">{destIcon(type, 22)}</div>
      <div className="destination-card__main">
        <div className="destination-card__name">{destination.name}</div>
        <div className="destination-card__sub">
          {latest ? (
            <>
              Latest deployment{" "}
              <span className="tooltip-wrap" tabIndex={0} aria-label={fullDate ?? ""}>
                {relativeTime(latest.createdAt)}
                <span className="tooltip-bubble" role="tooltip">{fullDate}</span>
              </span>
            </>
          ) : (
            "No deployments yet"
          )}
        </div>
      </div>
      <div className="destination-card__actions" onClick={(e) => e.stopPropagation()}>
        {latest && <DeployedBuildPill dep={latest} />}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton variant="menu" aria-label="More actions">
              <MoreVertical size={16} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>Edit</DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={onDelete}>Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function DeployedBuildPill({ dep }: { dep: DeploymentRow }) {
  const { appId } = useParams();
  const label = dep.buildNumber != null ? `#${dep.buildNumber}` : `#${dep.buildId.slice(0, 6)}`;
  return (
    <Link
      to={`/app/${appId}/build/builds/${dep.buildId}`}
      className="deployed-build-pill"
      onClick={(e) => e.stopPropagation()}
    >
      <PlatformBadge target={dep.buildTarget} />
      <span>Deployed build {label}</span>
    </Link>
  );
}

export function PlatformBadge({ target, size = 18 }: { target: BuildTarget; size?: number }) {
  const platform = target === "ios" ? "ios" : target === "android" ? "android" : "web";
  const iconSize = Math.round(size * 0.6);
  return (
    <span
      className="platform-badge"
      style={{ background: PLATFORM_ICON_BG[platform], width: size, height: size }}
      aria-hidden
    >
      {target === "ios" ? (
        <img src={appleIcon} alt="" width={iconSize} height={iconSize} className="platform-badge__icon" />
      ) : target === "android" ? (
        <img src={androidIcon} alt="" width={iconSize} height={iconSize} className="platform-badge__icon" />
      ) : (
        <span className="platform-badge__web">JS</span>
      )}
    </span>
  );
}

export function DestinationTargetLabel({ type }: { type: DestinationType | DestType }) {
  // Detail page "Target" cell — small platform icon + "iTunes Connect" /
  // "Google Play Console" label, mirroring the screenshot.
  const target: BuildTarget = type === "app_store" || type === "testflight" ? "ios" : "android";
  const label = target === "ios" ? "iTunes Connect" : "Google Play Console";
  const src = target === "ios" ? appStoreIcon : googlePlayIcon;
  return (
    <span className="dest-target-label">
      <img src={src} alt="" width={16} height={16} className="dest-target-label__icon" />
      <span>{label}</span>
    </span>
  );
}

// Re-export so the detail page can import without reaching into the dialog module.
export { TYPE_PLATFORM };
