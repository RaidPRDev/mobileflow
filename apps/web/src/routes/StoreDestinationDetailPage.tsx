import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CircleCheckBig,
  ExternalLink,
  GitBranch,
  MoreVertical,
  ScrollText,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Loading,
} from "@mobileflow/ui";
import {
  ApiError,
  api,
  type DeploymentRow,
  type DeploymentStatus,
  type DestinationConfigSummary,
  type DestinationRow,
} from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";
import { useAdaptivePageSize } from "../lib/useAdaptivePageSize";
import { useTableSort } from "../lib/useTableSort";
import { useCommitUrl } from "../lib/commitUrl";
import {
  allowNativeContextMenu,
  clearTextSelection,
  isInteractiveTarget,
} from "../lib/rowInteractions";
import { ListFooter } from "../components/ListFooter";
import { SortableHead } from "../components/SortableHead";
import { TableFillerRows, fillerCount } from "../components/TableFillerRows";
import { RowContextMenu, type RowAction } from "../components/RowActions";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { CircleXBig } from "../components/CircleXBig";
import { StoreDestinationDialog, type DestType } from "./StoreDestinationDialog";
import { DestinationTargetLabel, PlatformBadge } from "./StoreDestinationsPage";

const STATUS_TOOLTIP: Record<DeploymentStatus, string> = {
  queued: "Queued",
  running: "Running",
  success: "Deployment successful",
  failed: "Deployment failed",
  cancelled: "Cancelled",
};

export function StoreDestinationDetailPage() {
  const { appId, destId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const destQ = useQuery({
    queryKey: ["destinations", appId],
    queryFn: () => api.listDestinations(appId!),
    enabled: !!appId,
  });

  const depQ = useQuery({
    queryKey: ["deployments", appId],
    queryFn: () => api.listDeployments(appId!),
    enabled: !!appId,
    refetchInterval: 4000,
  });

  const destination = useMemo(
    () => destQ.data?.find((d) => d.id === destId) ?? null,
    [destQ.data, destId],
  );

  const history = useMemo(
    () => (depQ.data ?? []).filter((d) => d.destinationId === destId),
    [depQ.data, destId],
  );

  const remove = useMutation({
    mutationFn: () => api.deleteDestination(destId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["destinations", appId] });
      navigate(`/app/${appId}/deploy/store-destinations`);
    },
  });

  // Sort the whole history before paginating, so paging walks the sorted order
  // rather than reordering within each page.
  const { sorted, sortKey, dir, onSort } = useTableSort(
    history,
    {
      build: (d) => d.buildNumber ?? d.buildId,
      status: (d) => d.status,
      triggered: (d) => d.triggeredByName || d.triggeredByEmail || "",
      commit: (d) => d.buildCommitMessage?.split("\n")[0] || d.buildCommitSha,
    },
    "build",
    "desc",
  );

  // Resolved once here rather than per row: the two lookups behind it are shared
  // cache entries, and this keeps it to one hook instance.
  const commitUrl = useCommitUrl(appId);

  const historyGridRef = useRef<HTMLDivElement>(null);
  const pageSize = useAdaptivePageSize({
    rowHeight: 46,
    anchorRef: historyGridRef,
    reserve: 120,
    min: 5,
    max: 25,
  });
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(history.length / pageSize));
  const pageIdx = Math.min(page, pageCount - 1);
  const visible = sorted.slice(pageIdx * pageSize, pageIdx * pageSize + pageSize);

  if (destQ.isLoading) return <p className="settings-page__status"><Loading /></p>;
  if (destQ.error)
    return <p className="settings-page__status is-danger">{(destQ.error as ApiError).message}</p>;
  if (!destination) {
    return (
      <div className="page settings-page">
        <Link to={`/app/${appId}/deploy/store-destinations`} className="dest-back">
          <ArrowLeft size={14} /> Destinations
        </Link>
        <p className="settings-page__status is-danger">Destination not found.</p>
      </div>
    );
  }

  const type = destination.type as DestType;

  return (
    <div className="page settings-page dest-detail-page">
      <Link to={`/app/${appId}/deploy/store-destinations`} className="dest-back">
        <ArrowLeft size={14} /> Destinations
      </Link>

      <div className="page-header">
        <h1 className="page-title">{destination.name}</h1>
        <div className="page-actions">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton variant="menu" aria-label="More actions">
                <MoreVertical size={16} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem destructive onSelect={() => setConfirmingDelete(true)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <hr className="settings-divider" />

      <section className="settings-row">
        <div className="settings-row__label">Details</div>
        <div className="settings-row__content">
          <DetailsGrid destination={destination} type={type} />
        </div>
      </section>

      <hr className="settings-divider" />

      <section className="settings-row">
        <div className="settings-row__label">History</div>
        <div className="settings-row__content dest-history">
          {depQ.isLoading && (
            <div className="builds-status">
              <Loading />
            </div>
          )}
          {!depQ.isLoading && history.length === 0 && (
            <p className="settings-page__status">No deployments yet.</p>
          )}
          {history.length > 0 && (
            <>
              <div className="data-grid dest-history-table fade-in" role="table" ref={historyGridRef}>
                <SortableHead
                  columns={[
                    { key: "build", label: "Build" },
                    { key: "status", label: "Status" },
                    { key: "triggered", label: "Triggered by" },
                    { key: "commit", label: "Commit" },
                  ]}
                  sortKey={sortKey}
                  dir={dir}
                  onSort={onSort}
                />
                {visible.map((d) => (
                  <HistoryRow key={d.id} dep={d} commitUrl={commitUrl(d.buildCommitSha)} />
                ))}
                <TableFillerRows
                  gridRef={historyGridRef}
                  rowSelector=".dest-history-row"
                  count={fillerCount(pageSize, visible.length, pageCount)}
                  columns={4}
                />
              </div>
              <ListFooter
                total={history.length}
                pageIdx={pageIdx}
                pageCount={pageCount}
                unit="deployment"
                onPrev={() => setPage((p) => Math.max(0, p - 1))}
                onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                onPage={setPage}
              />
            </>
          )}
        </div>
      </section>

      {editing && (
        <StoreDestinationDialog
          appId={appId!}
          existing={destination}
          onClose={() => setEditing(false)}
        />
      )}

      {confirmingDelete && (
        <ConfirmDeleteDialog
          title="Delete store destination"
          itemName={destination.name}
          details={[
            "Stored credentials (Apple API key / .p12 / service-account JSON) will be permanently destroyed",
            history.length > 0
              ? `Deployment history (${history.length} entr${history.length === 1 ? "y" : "ies"}) is preserved, but new deploys will no longer be possible`
              : "New deploys to this destination will no longer be possible",
          ]}
          error={remove.error}
          pending={remove.isPending}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => remove.mutate()}
          confirmLabel="Delete destination"
        />
      )}
    </div>
  );
}

function DetailsGrid({ destination, type }: { destination: DestinationRow; type: DestType }) {
  const cfg = destination.configSummary;
  const cells = buildDetailCells(type, destination, cfg);
  return (
    <div className="dest-details-grid">
      {cells.map((c) => (
        <div key={c.label} className="dest-details-cell">
          <div className="dest-details-cell__label">{c.label}</div>
          <div className="dest-details-cell__value">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

function buildDetailCells(
  type: DestType,
  destination: DestinationRow,
  cfg: DestinationConfigSummary,
): { label: string; value: React.ReactNode }[] {
  if (type === "app_store") {
    const altool = "authMode" in cfg && cfg.authMode === "altool" ? cfg : null;
    const apiKey = "authMode" in cfg && cfg.authMode === "api_key" ? cfg : null;
    if (altool) {
      return [
        { label: "Target", value: <DestinationTargetLabel type={type} /> },
        { label: "Apple App ID", value: altool.appAppleId || destination.bundleId || "—" },
        { label: "Username", value: altool.appleId || "—" },
        { label: "Team ID", value: altool.teamId || "—" },
      ];
    }
    return [
      { label: "Target", value: <DestinationTargetLabel type={type} /> },
      { label: "Apple App ID", value: destination.bundleId || "—" },
      { label: "Issuer ID", value: apiKey?.issuerId || "—" },
      { label: "Key ID", value: apiKey?.keyId || "—" },
    ];
  }
  const artifact = "artifactKind" in cfg ? cfg.artifactKind : null;
  return [
    { label: "Target", value: <DestinationTargetLabel type={type} /> },
    { label: "Package", value: destination.bundleId || "—" },
    { label: "Track", value: destination.trackOrChannel || "—" },
    { label: "Format", value: artifact ? artifact.toUpperCase() : "—" },
  ];
}

function HistoryRow({ dep, commitUrl }: { dep: DeploymentRow; commitUrl: string | null }) {
  const { appId } = useParams();
  const navigate = useNavigate();
  const buildLabel = dep.buildNumber != null ? `#${dep.buildNumber}` : `#${dep.buildId.slice(0, 6)}`;
  const triggeredByName = dep.triggeredByName || dep.triggeredByEmail || "—";
  const triggeredByInitial = (triggeredByName || "?").trim().charAt(0).toUpperCase();
  const commitTitle = dep.buildCommitMessage?.split("\n")[0] || dep.buildCommitSha.slice(0, 6);
  const commitShort = dep.buildCommitSha.slice(0, 6);
  const buildFullDate = formatFullDate(dep.buildCreatedAt);
  const depFullDate = formatFullDate(dep.createdAt);

  const goToBuild = () => navigate(`/app/${appId}/build/builds/${dep.buildId}`);

  const actions: RowAction[] = [
    {
      label: "View deployment build",
      icon: <ScrollText size={14} />,
      onSelect: goToBuild,
    },
    {
      label: "View commit",
      icon: <ExternalLink size={14} />,
      // noopener: the provider's tab must not get a handle on this window.
      onSelect: () => commitUrl && window.open(commitUrl, "_blank", "noopener,noreferrer"),
      disabled: !commitUrl,
      title: commitUrl ?? "No repository connected for this app",
    },
  ];

  return (
    <RowContextMenu actions={actions}>
      {/* Double-click opens the build, same destination as the context menu's
          "View deployment build". No single-click handler to race here, so this
          needs none of the click-delay juggling `DestinationListItem` does. */}
      <div
        className="data-grid__row dest-history-row"
        role="row"
        onDoubleClick={(e) => {
          // A double-click on the build or commit link belongs to that link.
          if (isInteractiveTarget(e.target)) return;
          clearTextSelection();
          goToBuild();
        }}
      >
        <div role="cell" className="dest-history-row__build">
          <Link
            to={`/app/${appId}/build/builds/${dep.buildId}`}
            className="deployments-row__build-link"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={allowNativeContextMenu}
          >
            <PlatformBadge target={dep.buildTarget} />
            {buildLabel}
          </Link>
        </div>
        <div role="cell" className="dest-history-row__status">
          {dep.status === "success" ? (
            <span className="tooltip-wrap" tabIndex={0}>
              <CircleCheckBig size={24} className="status-icon is-success" aria-hidden />
              <span className="tooltip-bubble" role="tooltip">{STATUS_TOOLTIP.success}</span>
            </span>
          ) : dep.status === "failed" ? (
            <span className="tooltip-wrap" tabIndex={0}>
              <CircleXBig size={24} className="status-icon is-failed" aria-hidden />
              <span className="tooltip-bubble" role="tooltip">{STATUS_TOOLTIP.failed}</span>
            </span>
          ) : (
            <span className={`status-pill is-${dep.status}`}>{dep.status}</span>
          )}
        </div>
        <div role="cell" className="dest-history-row__triggered">
          <span className="deployments-row__triggered-avatar">
            <span className="commit-row__avatar-fallback">{triggeredByInitial}</span>
          </span>
          <div className="deployments-row__triggered-meta">
            <span className="deployments-row__triggered-name">{triggeredByName}</span>
            <span className="tooltip-wrap deployments-row__triggered-date" tabIndex={0} aria-label={depFullDate}>
              {relativeTime(dep.createdAt)}
              <span className="tooltip-bubble" role="tooltip">{depFullDate}</span>
            </span>
          </div>
        </div>
        <div role="cell" className="dest-history-row__commit">
          <span className="deployments-row__commit-avatar">
            <span className="commit-row__avatar-fallback">C</span>
          </span>
          <div className="deployments-row__commit-meta">
            <div className="deployments-row__commit-line">
              {/* Was a dead `#commit-<sha>` placeholder; now the provider's commit
                  page, falling back to plain text when no repo is connected. */}
              {commitUrl ? (
                <a
                  className="deployments-row__commit-sha"
                  href={commitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  onContextMenu={allowNativeContextMenu}
                >
                  {commitShort}
                </a>
              ) : (
                <span className="deployments-row__commit-sha">{commitShort}</span>
              )}
              <span className="deployments-row__commit-msg">{commitTitle}</span>
            </div>
            <div className="deployments-row__commit-sub">
              <span className="tooltip-wrap" tabIndex={0} aria-label={buildFullDate}>
                {relativeTime(dep.buildCreatedAt)}
                <span className="tooltip-bubble" role="tooltip">{buildFullDate}</span>
              </span>
              {dep.buildBranch && (
                <>
                  <span className="commit-row__from">from</span>
                  <span className="commit-row__branch">
                    <GitBranch size={11} aria-hidden />
                    <span>{dep.buildBranch}</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </RowContextMenu>
  );
}
