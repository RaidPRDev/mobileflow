import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  GitBranch,
  MoreVertical,
  XCircle,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
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
import { ListFooter } from "../components/ListFooter";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
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
  const visible = history.slice(pageIdx * pageSize, pageIdx * pageSize + pageSize);

  if (destQ.isLoading) return <p className="settings-page__status">Loading…</p>;
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
          {depQ.isLoading && <div className="builds-status">Loading…</div>}
          {!depQ.isLoading && history.length === 0 && (
            <p className="settings-page__status">No deployments yet.</p>
          )}
          {history.length > 0 && (
            <>
              <div className="data-grid dest-history-table" role="table" ref={historyGridRef}>
                <div className="data-grid__head" role="row">
                  <span role="columnheader">Build</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Triggered by</span>
                  <span role="columnheader">Commit</span>
                  <span role="columnheader" aria-label="Outcome"></span>
                </div>
                {visible.map((d) => (
                  <HistoryRow key={d.id} dep={d} />
                ))}
              </div>
              <ListFooter
                total={history.length}
                pageIdx={pageIdx}
                pageCount={pageCount}
                unit="deployment"
                onPrev={() => setPage((p) => Math.max(0, p - 1))}
                onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
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

function HistoryRow({ dep }: { dep: DeploymentRow }) {
  const { appId } = useParams();
  const buildLabel = dep.buildNumber != null ? `#${dep.buildNumber}` : `#${dep.buildId.slice(0, 6)}`;
  const triggeredByName = dep.triggeredByName || dep.triggeredByEmail || "—";
  const triggeredByInitial = (triggeredByName || "?").trim().charAt(0).toUpperCase();
  const commitTitle = dep.buildCommitMessage?.split("\n")[0] || dep.buildCommitSha.slice(0, 6);
  const commitShort = dep.buildCommitSha.slice(0, 6);
  const buildFullDate = formatFullDate(dep.buildCreatedAt);
  const depFullDate = formatFullDate(dep.createdAt);
  const outcome =
    dep.status === "success"
      ? { icon: <CheckCircle2 size={14} className="status-icon is-success" aria-hidden />, label: "Submitted" }
      : dep.status === "failed"
        ? { icon: <XCircle size={14} className="status-icon is-failed" aria-hidden />, label: "Failed" }
        : null;

  return (
    <div className="data-grid__row dest-history-row" role="row">
      <div role="cell" className="dest-history-row__build">
        <Link
          to={`/app/${appId}/build/builds/${dep.buildId}`}
          className="deployments-row__build-link"
          onClick={(e) => e.stopPropagation()}
        >
          <PlatformBadge target={dep.buildTarget} />
          {buildLabel}
        </Link>
      </div>
      <div role="cell" className="dest-history-row__status">
        {dep.status === "success" ? (
          <span className="tooltip-wrap" tabIndex={0}>
            <CheckCircle2 size={18} className="status-icon is-success" aria-hidden />
            <span className="tooltip-bubble" role="tooltip">{STATUS_TOOLTIP.success}</span>
          </span>
        ) : dep.status === "failed" ? (
          <span className="tooltip-wrap" tabIndex={0}>
            <XCircle size={18} className="status-icon is-failed" aria-hidden />
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
            <a
              className="deployments-row__commit-sha"
              href={`#commit-${commitShort}`}
              onClick={(e) => e.stopPropagation()}
            >
              {commitShort}
            </a>
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
      <div role="cell" className="dest-history-row__outcome">
        {outcome ? (
          <span className={`dest-history-outcome is-${dep.status}`}>
            {outcome.icon}
            <span>{outcome.label}</span>
          </span>
        ) : (
          <span className={`status-pill is-${dep.status}`}>{dep.status}</span>
        )}
      </div>
    </div>
  );
}
