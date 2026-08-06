import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Loading,
} from "@mobileflow/ui";
import { CircleCheckBig, Eye, GitBranch, Plus } from "lucide-react";
import {
  ApiError,
  api,
  type BuildTarget,
  type DeploymentRow,
  type DeploymentStatus,
  type DestinationType,
} from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";
import { useAdaptivePageSize } from "../lib/useAdaptivePageSize";
import { useTableSort } from "../lib/useTableSort";
import { ListFooter } from "../components/ListFooter";
import { SortableHead } from "../components/SortableHead";
import { TableFillerRows, fillerCount } from "../components/TableFillerRows";
import { CircleXBig } from "../components/CircleXBig";
import { AndroidIcon } from "../components/AndroidIcon";
import { RowContextMenu, type RowAction } from "../components/RowActions";
import { allowNativeContextMenu } from "../lib/rowInteractions";

const PLATFORM_META: Record<BuildTarget, { label: string; iconBg: string; icon: JSX.Element }> = {
  ios: { label: "iOS", iconBg: "#0a0a0a", icon: <AppleIcon /> },
  android: { label: "Android", iconBg: "#34a853", icon: <AndroidIcon /> },
  web: { label: "Web", iconBg: "#f7df1e", icon: <WebIcon /> },
};

const STATUS_TOOLTIP: Record<DeploymentStatus, string> = {
  queued: "Queued",
  running: "Running",
  success: "Deployment successful",
  failed: "Deployment failed",
  cancelled: "Cancelled",
};

const DESTINATION_LABEL: Record<DestinationType, string> = {
  app_store: "appstore",
  testflight: "testflight",
  play_store: "play store",
  play_internal: "play internal",
};

/** Shared by the Target cell and the Target column's sort accessor. */
function targetLabelOf(dep: DeploymentRow): string {
  return `${dep.destinationName} ${DESTINATION_LABEL[dep.destinationType] ?? dep.destinationType}`;
}

export function DeploymentsPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(null);

  // Auto-open the log modal when arriving from the wizard with ?open=<id>.
  // Strip the param after consuming it so a refresh doesn't re-open the modal.
  useEffect(() => {
    const open = params.get("open");
    if (open) {
      setOpenId(open);
      const next = new URLSearchParams(params);
      next.delete("open");
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  const list = useQuery({
    queryKey: ["deployments", appId],
    queryFn: () => api.listDeployments(appId!),
    enabled: !!appId,
    refetchInterval: 4000,
  });

  const gridRef = useRef<HTMLDivElement>(null);
  const pageSize = useAdaptivePageSize({
    rowHeight: 56,
    anchorRef: gridRef,
    reserve: 130,
    min: 5,
    max: 30,
  });
  const [page, setPage] = useState(0);
  const all = useMemo(() => list.data ?? [], [list.data]);
  const total = all.length;

  // Sort the whole list, then paginate the result — the other way round would
  // only reorder within each page.
  const { sorted, sortKey, dir, onSort } = useTableSort(
    all,
    {
      triggered: (d) => d.triggeredByName || d.triggeredByEmail || "",
      type: () => "Binary",
      status: (d) => d.status,
      target: (d) => targetLabelOf(d),
      build: (d) => d.buildNumber ?? d.buildId,
      commit: (d) => d.buildCommitMessage?.split("\n")[0] || d.buildCommitSha,
    },
    "commit",
    "desc",
  );

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageIdx = Math.min(page, pageCount - 1);
  const visible = sorted.slice(pageIdx * pageSize, pageIdx * pageSize + pageSize);

  return (
    <div className="builds-page">
      <header className="builds-page__header">
        <h1 className="page-title">Deployments</h1>
        <div className="builds-page__actions">
          <Button size="sm" onClick={() => navigate(`/app/${appId}/deploy/deployments/new`)}>
            New deployment
          </Button>
        </div>
      </header>

      {list.isLoading && (
        <div className="builds-status">
          <Loading>Loading deployments…</Loading>
        </div>
      )}
      {list.error && <div className="builds-status is-error">{(list.error as ApiError).message}</div>}

      {list.data?.length === 0 && (
        <div className="builds-empty">
          <h2 className="builds-empty__title">No deployments yet</h2>
          <p className="builds-empty__body">
            Pick a successful build and a destination to deploy.{" "}
            <Link to={`/app/${appId}/deploy/store-destinations`} className="builds-empty__link">
              Manage destinations
            </Link>
          </p>
          <Button onClick={() => navigate(`/app/${appId}/deploy/deployments/new`)}>
            New deployment
          </Button>
        </div>
      )}

      {total > 0 && (
        <>
          <div className="data-grid deployments-table fade-in" role="table" ref={gridRef}>
            <SortableHead
              columns={[
                { key: "triggered", label: "Triggered by" },
                { key: "type", label: "Type" },
                { key: "status", label: "Status" },
                { key: "target", label: "Target" },
                { key: "build", label: "Build" },
                { key: "commit", label: "Commit" },
              ]}
              sortKey={sortKey}
              dir={dir}
              onSort={onSort}
            />
            {visible.map((d) => (
              <DeploymentRowItem key={d.id} dep={d} onOpen={() => setOpenId(d.id)} />
            ))}
            <TableFillerRows
              gridRef={gridRef}
              rowSelector=".deployments-row"
              count={fillerCount(pageSize, visible.length, pageCount)}
              columns={6}
            />
          </div>
          <ListFooter
            total={total}
            pageIdx={pageIdx}
            pageCount={pageCount}
            unit="deployment"
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            onPage={setPage}
          />
        </>
      )}

      <DeploymentLogDialog
        deploymentId={openId}
        onOpenChange={(open) => !open && setOpenId(null)}
      />
    </div>
  );
}

interface DeploymentRowItemProps {
  dep: DeploymentRow;
  onOpen: () => void;
}

function DeploymentRowItem({ dep, onOpen }: DeploymentRowItemProps) {
  const { appId } = useParams();
  const navigate = useNavigate();
  const platform = PLATFORM_META[dep.buildTarget];
  const triggeredByName = dep.triggeredByName || dep.triggeredByEmail || "—";
  const triggeredByInitial = (triggeredByName || "?").trim().charAt(0).toUpperCase();
  const commitTitle = dep.buildCommitMessage?.split("\n")[0] || dep.buildCommitSha.slice(0, 6);
  const commitShort = dep.buildCommitSha.slice(0, 6);
  const fullDate = formatFullDate(dep.createdAt);
  const buildFullDate = formatFullDate(dep.buildCreatedAt);
  const buildLabel = dep.buildNumber != null ? `#${dep.buildNumber}` : `#${dep.buildId.slice(0, 6)}`;
  const targetLabel = targetLabelOf(dep);

  const actions: RowAction[] = [
    { label: "View deployment", icon: <Eye size={14} />, onSelect: onOpen },
    {
      label: "New deployment",
      icon: <Plus size={14} />,
      onSelect: () => navigate(`/app/${appId}/deploy/deployments/new`),
    },
  ];

  return (
    <RowContextMenu actions={actions}>
      <button type="button" className="data-grid__row deployments-row" role="row" onClick={onOpen}>
        <div role="cell" className="deployments-row__triggered">
          <span className="deployments-row__triggered-avatar">
            <span className="commit-row__avatar-fallback">{triggeredByInitial}</span>
          </span>
          <div className="deployments-row__triggered-meta">
            <span className="deployments-row__triggered-name">{triggeredByName}</span>
            <span
              className="tooltip-wrap deployments-row__triggered-date"
              tabIndex={0}
              aria-label={fullDate}
            >
              {relativeTime(dep.createdAt)}
              <span className="tooltip-bubble" role="tooltip">{fullDate}</span>
            </span>
          </div>
        </div>
        <div role="cell" className="deployments-row__type">Binary</div>
        <div role="cell" className="deployments-row__status">
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
        <div role="cell" className="deployments-row__target">
          {/* The tooltip carries the full target: the label truncates as the
              column narrows and drops entirely on small screens, leaving the
              icon. The bubble sits outside the pill because the pill clips its
              own overflow for the ellipsis and would crop it. */}
          <span className="tooltip-wrap pill-tooltip-wrap" tabIndex={0} aria-label={targetLabel}>
            <span className="deployments-row__target-pill">
              <span
                className="deployments-row__target-icon"
                style={{ background: platform.iconBg }}
              >
                {platform.icon}
              </span>
              <span className="deployments-row__target-label">{targetLabel}</span>
            </span>
            <span className="tooltip-bubble" role="tooltip">{targetLabel}</span>
          </span>
        </div>
        <div role="cell" className="deployments-row__build">
          <Link
            to={`/app/${appId}/build/builds/${dep.buildId}`}
            className="deployments-row__build-link"
            onClick={(e) => e.stopPropagation()}
            // Right-clicking the build link keeps the browser's own menu
            // ("Open in new tab") instead of the row's actions.
            onContextMenu={allowNativeContextMenu}
          >
            <span className="deployments-row__build-icon" style={{ background: platform.iconBg }}>
              {platform.icon}
            </span>
            {buildLabel}
          </Link>
        </div>
        <div role="cell" className="deployments-row__commit">
          <span className="deployments-row__commit-avatar">
            <span className="commit-row__avatar-fallback">C</span>
          </span>
          <div className="deployments-row__commit-meta">
            <div className="deployments-row__commit-line">
              <span className="deployments-row__commit-sha">{commitShort}</span>
              <span className="deployments-row__commit-msg">{commitTitle}</span>
            </div>
            <div className="deployments-row__commit-sub">
              <span
                className="tooltip-wrap"
                tabIndex={0}
                aria-label={buildFullDate}
              >
                {relativeTime(dep.buildCreatedAt)}
                <span className="tooltip-bubble" role="tooltip">{buildFullDate}</span>
              </span>
              {dep.buildBranch && (
                <>
                  <span className="commit-row__from">to</span>
                  <span className="commit-row__branch">
                    <GitBranch size={11} aria-hidden />
                    <span>{dep.buildBranch}</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </button>
    </RowContextMenu>
  );
}

function DeploymentLogDialog({
  deploymentId,
  onOpenChange,
}: {
  deploymentId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  // Poll while the modal is open: deployments that are running update their
  // logText live so users see streaming output without manual refresh.
  const detail = useQuery({
    queryKey: ["deployment", deploymentId],
    queryFn: () => api.getDeployment(deploymentId!),
    enabled: !!deploymentId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status === "queued" || status === "running" ? 2000 : false;
    },
  });

  const d = detail.data;
  const open = !!deploymentId;
  const shortId = deploymentId?.slice(0, 8) ?? "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="deployment-log-dialog" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="deployment-log-dialog__title">
            <span>Deployment {shortId}</span>
            {d && (
              <span className={`status-pill is-${d.status}`}>{d.status}</span>
            )}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="deployment-log-dialog__body">
          {detail.isLoading && (
            <div className="deployment-log-dialog__loading">
              <Loading />
            </div>
          )}
          {detail.error && (
            <div className="deployment-log-dialog__error">
              {(detail.error as ApiError).message}
            </div>
          )}
          {d && (
            <pre className="deployment-log-dialog__log">
              {d.logText || <span className="deployment-log-dialog__empty">(no output yet)</span>}
            </pre>
          )}
          {d?.errorMessage && (
            <div className="deployment-log-dialog__error">
              <strong>Error</strong>
              <pre>{d.errorMessage}</pre>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function AppleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.665 16.811a10.316 10.316 0 0 1-1.021 1.837c-.537.767-.978 1.297-1.316 1.592-.525.482-1.089.73-1.692.744-.432 0-.954-.123-1.562-.373-.61-.249-1.17-.371-1.683-.371-.537 0-1.113.122-1.73.371-.616.25-1.114.381-1.495.393-.577.025-1.154-.229-1.729-.764-.367-.318-.83-.866-1.388-1.645-.598-.83-1.087-1.79-1.467-2.876-.413-1.17-.62-2.305-.62-3.402 0-1.257.272-2.34.815-3.249.428-.728 1-1.301 1.715-1.72.713-.42 1.485-.633 2.314-.647.46 0 1.063.142 1.81.422.745.28 1.225.422 1.435.422.158 0 .69-.165 1.594-.493.857-.305 1.58-.43 2.17-.382 1.605.13 2.81.764 3.612 1.905-1.434.873-2.144 2.094-2.13 3.66.013 1.222.451 2.238 1.314 3.046.39.371.825.658 1.31.864-.105.305-.215.598-.331.879zm-3.873-15.43c0 .938-.342 1.815-1.027 2.628-.825.964-1.823 1.522-2.906 1.434a2.93 2.93 0 0 1-.022-.354c0-.9.392-1.864 1.087-2.654.347-.4.787-.733 1.32-1 .533-.262 1.037-.408 1.512-.434.014.13.036.26.036.38z" />
    </svg>
  );
}

function WebIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <text x="12" y="17" textAnchor="middle" fontSize="10" fontFamily="Arial, sans-serif" fontWeight="700" fill="#0a0a0a">JS</text>
    </svg>
  );
}
