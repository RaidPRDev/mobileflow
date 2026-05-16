import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "@mobileflow/ui";
import { CheckCircle2, GitBranch, MoreVertical, XCircle } from "lucide-react";
import { ApiError, api, type BuildRow, type BuildStatus, type BuildTarget } from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";

const PLATFORM_META: Record<BuildTarget, { label: string; iconBg: string; icon: JSX.Element }> = {
  ios: { label: "iOS", iconBg: "#0a0a0a", icon: <AppleIcon /> },
  android: { label: "Android", iconBg: "#34a853", icon: <AndroidIcon /> },
  web: { label: "Web", iconBg: "#f7df1e", icon: <WebIcon /> },
};

const STATUS_TOOLTIP: Record<BuildStatus, string> = {
  queued: "Queued",
  running: "Running",
  success: "Build successful",
  failed: "Build failed",
  cancelled: "Build cancelled",
};

const DESTINATION_LABEL: Record<string, string> = {
  app_store: "appstore",
  testflight: "testflight",
  play_store: "play store",
  play_internal: "play internal",
};

export function BuildsPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const buildsQ = useQuery({
    queryKey: ["builds", appId],
    queryFn: () => api.listBuilds(appId!),
    enabled: !!appId,
    refetchInterval: 4000,
  });

  // Builds returned newest first; assign sequential numbers so the latest gets the highest #.
  const numbered = useMemo(() => {
    const list = buildsQ.data ?? [];
    const total = list.length;
    return list.map((b, i) => ({ build: b, number: total - i }));
  }, [buildsQ.data]);

  const rerun = useMutation({
    mutationFn: (b: BuildRow) =>
      api.startBuild(appId!, {
        commitSha: b.commitSha,
        commitMessage: b.commitMessage ?? undefined,
        branch: b.branch ?? undefined,
        target: b.target,
        stackId: b.stackId,
        buildType: b.buildType ?? undefined,
        environmentId: b.environmentId ?? undefined,
      }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ["builds", appId] });
      navigate(`/app/${appId}/build/builds/${b.id}`);
    },
  });

  return (
    <div className="builds-page">
      <header className="builds-page__header">
        <h1 className="builds-page__title">Builds</h1>
        <div className="builds-page__actions">
          <Button variant="outline" size="sm">
            Filter
          </Button>
          <Button size="sm" onClick={() => navigate(`/app/${appId}/build/builds/new`)}>
            New build
          </Button>
        </div>
      </header>

      {buildsQ.isLoading && <div className="builds-status">Loading builds…</div>}
      {buildsQ.error && (
        <div className="builds-status is-error">{(buildsQ.error as ApiError).message}</div>
      )}

      {buildsQ.data?.length === 0 && (
        <div className="builds-empty">
          <h2 className="builds-empty__title">No builds history</h2>
          <p className="builds-empty__body">Pick a commit to start your first build.</p>
          <Button asChild>
            <Link to={`/app/${appId}/build/builds/new`}>Create your first build</Link>
          </Button>
        </div>
      )}

      {!!numbered.length && (
        <div className="data-grid builds-table" role="table">
          <div className="data-grid__head" role="row">
            <span role="columnheader">Build</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Platform</span>
            <span role="columnheader">Triggered by</span>
            <span role="columnheader">Commit</span>
            <span role="columnheader">Deployment</span>
            <span role="columnheader" aria-label="Actions"></span>
          </div>
          {numbered.map(({ build, number }) => (
            <BuildRowItem
              key={build.id}
              build={build}
              number={number}
              accountAvatarUrl={null}
              onRerun={() => rerun.mutate(build)}
            />
          ))}
        </div>
      )}

    </div>
  );
}

interface BuildRowItemProps {
  build: BuildRow;
  number: number;
  accountAvatarUrl: string | null;
  onRerun: () => void;
}

function BuildRowItem({ build, number, accountAvatarUrl, onRerun }: BuildRowItemProps) {
  const { appId } = useParams();
  const navigate = useNavigate();
  const platform = PLATFORM_META[build.target];
  const triggeredByName = build.triggeredByName || build.triggeredByEmail || "—";
  const triggeredByInitial = (triggeredByName || "?").trim().charAt(0).toUpperCase();
  const commitTitle = build.commitMessage?.split("\n")[0] || build.commitSha.slice(0, 6);
  const commitShort = build.commitSha.slice(0, 6);
  const fullDate = formatFullDate(build.createdAt);
  const successOrFail = build.status === "success" || build.status === "failed";
  const dep = build.deployments?.[0] ?? null;
  const ipa = build.target === "ios"
    ? build.artifacts?.find((a) => a.kind === "ipa")?.url ?? null
    : null;
  const aab = build.target === "android"
    ? build.artifacts?.find((a) => a.kind === "aab" || a.kind === "apk")?.url ?? null
    : null;

  const goToBuild = () => navigate(`/app/${appId}/build/builds/${build.id}`);

  return (
    <div
      className="data-grid__row builds-row is-clickable"
      role="row"
      onClick={goToBuild}
    >
      <div role="cell" className="builds-row__build-cell">
        <button
          type="button"
          className="builds-row__build"
          onClick={(e) => {
            e.stopPropagation();
            goToBuild();
          }}
        >
          #{number}
        </button>
      </div>
      <div role="cell" className="builds-row__status">
        {build.status === "success" ? (
          <span className="tooltip-wrap" tabIndex={0}>
            <CheckCircle2 size={18} className="status-icon is-success" aria-hidden />
            <span className="tooltip-bubble" role="tooltip">{STATUS_TOOLTIP.success}</span>
          </span>
        ) : build.status === "failed" ? (
          <span className="tooltip-wrap" tabIndex={0}>
            <XCircle size={18} className="status-icon is-failed" aria-hidden />
            <span className="tooltip-bubble" role="tooltip">{STATUS_TOOLTIP.failed}</span>
          </span>
        ) : (
          <span className={`status-pill is-${build.status}`}>{build.status}</span>
        )}
      </div>
      <div role="cell" className="builds-row__platform">
        <span className="builds-row__platform-icon" style={{ background: platform.iconBg }}>
          {platform.icon}
        </span>
        <span className="builds-row__platform-label">{platform.label}</span>
      </div>
      <div role="cell" className="builds-row__triggered">
        <span className="builds-row__triggered-avatar">
          <span className="commit-row__avatar-fallback">{triggeredByInitial}</span>
        </span>
        <div className="builds-row__triggered-meta">
          <span className="builds-row__triggered-name">{triggeredByName}</span>
          <span
            className="tooltip-wrap builds-row__triggered-date"
            tabIndex={0}
            aria-label={fullDate}
          >
            {relativeTime(build.createdAt)}
            <span className="tooltip-bubble" role="tooltip">{fullDate}</span>
          </span>
        </div>
      </div>
      <div role="cell" className="builds-row__commit">
        <span className="builds-row__commit-avatar">
          {accountAvatarUrl ? (
            <img src={accountAvatarUrl} alt="" />
          ) : (
            <span className="commit-row__avatar-fallback">C</span>
          )}
        </span>
        <div className="builds-row__commit-meta">
          <div className="builds-row__commit-line">
            <span className="builds-row__commit-sha">{commitShort}</span>
            <span className="builds-row__commit-msg">{commitTitle}</span>
          </div>
          <div className="builds-row__commit-sub">
            <span
              className="tooltip-wrap"
              tabIndex={0}
              aria-label={fullDate}
            >
              {relativeTime(build.createdAt)}
              <span className="tooltip-bubble" role="tooltip">{fullDate}</span>
            </span>
            {build.branch && (
              <>
                <span className="commit-row__from">to</span>
                <span className="commit-row__branch">
                  <GitBranch size={11} aria-hidden />
                  <span>{build.branch}</span>
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      <div role="cell" className="builds-row__deployment">
        {dep ? (
          <span className="deployment-pill">
            {dep.destinationName ?? "—"}
            {dep.destinationType ? ` / ${DESTINATION_LABEL[dep.destinationType] ?? dep.destinationType}` : ""}
          </span>
        ) : (
          <span className="builds-row__deployment-empty">—</span>
        )}
      </div>
      <div role="cell" className="builds-row__menu" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton variant="ghost" size="icon-sm" aria-label="Build actions">
              <MoreVertical size={16} />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={goToBuild}>View build</DropdownMenuItem>
            <DropdownMenuItem onSelect={onRerun}>Rerun build</DropdownMenuItem>
            {build.target === "ios" && (
              <>
                <DropdownMenuItem disabled={!dep}>Send to App Store</DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!ipa}
                  onSelect={() => ipa && window.open(ipa, "_blank", "noreferrer")}
                >
                  Download IPA
                </DropdownMenuItem>
              </>
            )}
            {build.target === "android" && (
              <>
                <DropdownMenuItem disabled={!dep}>Send to Google Play Store</DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!aab}
                  onSelect={() => aab && window.open(aab, "_blank", "noreferrer")}
                >
                  Download AAB
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function AppleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.665 16.811a10.316 10.316 0 0 1-1.021 1.837c-.537.767-.978 1.297-1.316 1.592-.525.482-1.089.73-1.692.744-.432 0-.954-.123-1.562-.373-.61-.249-1.17-.371-1.683-.371-.537 0-1.113.122-1.73.371-.616.25-1.114.381-1.495.393-.577.025-1.154-.229-1.729-.764-.367-.318-.83-.866-1.388-1.645-.598-.83-1.087-1.79-1.467-2.876-.413-1.17-.62-2.305-.62-3.402 0-1.257.272-2.34.815-3.249.428-.728 1-1.301 1.715-1.72.713-.42 1.485-.633 2.314-.647.46 0 1.063.142 1.81.422.745.28 1.225.422 1.435.422.158 0 .69-.165 1.594-.493.857-.305 1.58-.43 2.17-.382 1.605.13 2.81.764 3.612 1.905-1.434.873-2.144 2.094-2.13 3.66.013 1.222.451 2.238 1.314 3.046.39.371.825.658 1.31.864-.105.305-.215.598-.331.879zm-3.873-15.43c0 .938-.342 1.815-1.027 2.628-.825.964-1.823 1.522-2.906 1.434a2.93 2.93 0 0 1-.022-.354c0-.9.392-1.864 1.087-2.654.347-.4.787-.733 1.32-1 .533-.262 1.037-.408 1.512-.434.014.13.036.26.036.38z" />
    </svg>
  );
}

function AndroidIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.523 15.341a1.04 1.04 0 1 1 0-2.082 1.04 1.04 0 0 1 0 2.082m-11.046 0a1.04 1.04 0 1 1 0-2.082 1.04 1.04 0 0 1 0 2.082m11.42-6.02 2.078-3.6a.43.43 0 1 0-.745-.43l-2.103 3.643a13.05 13.05 0 0 0-5.127-1.04c-1.842 0-3.59.378-5.127 1.04L4.77 5.291a.43.43 0 1 0-.745.43l2.078 3.6C2.554 11.218 0 14.696 0 18.708h24c0-4.012-2.554-7.49-6.103-9.387" />
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
