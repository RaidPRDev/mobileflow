import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Combobox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  type ComboboxOption,
} from "@mobileflow/ui";
import { CheckCircle2, GitBranch, XCircle } from "lucide-react";
import { ApiError, api, type BuildRow, type BuildStatus, type BuildTarget } from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";
import { useAdaptivePageSize } from "../lib/useAdaptivePageSize";
import { ListFooter } from "../components/ListFooter";

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

type StateFilter = "all" | BuildStatus;
type PlatformFilter = "all" | BuildTarget;

const STATE_OPTIONS: ComboboxOption<StateFilter>[] = [
  { value: "all", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "success", label: "Success" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

const PLATFORM_OPTIONS: ComboboxOption<PlatformFilter>[] = [
  { value: "all", label: "All" },
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" },
  { value: "web", label: "Web" },
];

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

  const [filterOpen, setFilterOpen] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");

  // Number builds against the full list so #N stays stable when filtering,
  // then drop rows that don't match the active state/platform filters.
  const numbered = useMemo(() => {
    const list = buildsQ.data ?? [];
    const total = list.length;
    return list
      .map((b, i) => ({ build: b, number: total - i }))
      .filter(({ build }) => stateFilter === "all" || build.status === stateFilter)
      .filter(({ build }) => platformFilter === "all" || build.target === platformFilter);
  }, [buildsQ.data, stateFilter, platformFilter]);

  const filterCount = (stateFilter !== "all" ? 1 : 0) + (platformFilter !== "all" ? 1 : 0);

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
        <h1 className="page-title">Builds</h1>
        <div className="builds-page__actions">
          <BuildsFilter
            open={filterOpen}
            onOpenChange={setFilterOpen}
            stateFilter={stateFilter}
            onStateChange={setStateFilter}
            platformFilter={platformFilter}
            onPlatformChange={setPlatformFilter}
            count={filterCount}
          />
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

      {!!buildsQ.data?.length && numbered.length === 0 && (
        <div className="builds-empty">
          <h2 className="builds-empty__title">No builds match your filters</h2>
          <p className="builds-empty__body">
            Try a different {filterCount > 1 ? "combination" : "filter"} or clear it to see all builds.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setStateFilter("all");
              setPlatformFilter("all");
            }}
          >
            Clear filters
          </Button>
        </div>
      )}

      {!!numbered.length && (
        <BuildsList numbered={numbered} onRerun={(b) => rerun.mutate(b)} />
      )}

    </div>
  );
}

function BuildsList({
  numbered,
  onRerun,
}: {
  numbered: { build: BuildRow; number: number }[];
  onRerun: (b: BuildRow) => void;
}) {
  // Anchor on the data-grid container (not its head, which uses
  // `display: contents` and reports an unreliable bounding rect). Reserve
  // covers the column header row + footer + app-content bottom padding.
  const gridRef = useRef<HTMLDivElement>(null);
  const pageSize = useAdaptivePageSize({
    rowHeight: 68,
    anchorRef: gridRef,
    reserve: 130,
    min: 5,
    max: 30,
  });
  const [page, setPage] = useState(0);
  const total = numbered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageIdx = Math.min(page, pageCount - 1);
  const visible = numbered.slice(pageIdx * pageSize, pageIdx * pageSize + pageSize);

  return (
    <>
      <div className="data-grid builds-table" role="table" ref={gridRef}>
        <div className="data-grid__head" role="row">
          <span role="columnheader">Build</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Platform</span>
          <span role="columnheader">Triggered by</span>
          <span role="columnheader">Commit</span>
          <span role="columnheader">Deployment</span>
          <span role="columnheader" aria-label="Actions"></span>
        </div>
        {visible.map(({ build, number }) => (
          <BuildRowItem
            key={build.id}
            build={build}
            number={number}
            accountAvatarUrl={null}
            onRerun={() => onRerun(build)}
          />
        ))}
      </div>
      <ListFooter
        total={total}
        pageIdx={pageIdx}
        pageCount={pageCount}
        unit="build"
        onPrev={() => setPage((p) => Math.max(0, p - 1))}
        onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
      />
    </>
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
            <IconButton variant="menu" aria-label="Build actions" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={goToBuild}>View build</DropdownMenuItem>
            <DropdownMenuItem onSelect={onRerun}>Rerun build</DropdownMenuItem>
            {build.status === "success" && build.target === "ios" && (
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
            {build.status === "success" && build.target === "android" && (
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

interface BuildsFilterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stateFilter: StateFilter;
  onStateChange: (v: StateFilter) => void;
  platformFilter: PlatformFilter;
  onPlatformChange: (v: PlatformFilter) => void;
  count: number;
}

function BuildsFilter({
  open,
  onOpenChange,
  stateFilter,
  onStateChange,
  platformFilter,
  onPlatformChange,
  count,
}: BuildsFilterProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      // Combobox portals its options outside this popover; treat clicks inside
      // a Radix popper as still "inside" so picking an option doesn't tear
      // down the filter before Radix commits the value.
      if (target.closest("[data-radix-popper-content-wrapper]")) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div className="builds-filter" ref={rootRef}>
      <Button variant="outline" size="sm" onClick={() => onOpenChange(!open)}>
        Filter{count > 0 ? ` · ${count}` : ""}
      </Button>
      {open && (
        <div className="builds-filter__popover" role="dialog" aria-label="Filter builds">
          <div className="builds-filter__field">
            <label className="builds-filter__label" htmlFor="builds-filter-state">State</label>
            <Combobox<StateFilter>
              id="builds-filter-state"
              value={stateFilter}
              onChange={onStateChange}
              options={STATE_OPTIONS}
            />
          </div>
          <div className="builds-filter__field">
            <label className="builds-filter__label" htmlFor="builds-filter-platform">Platform</label>
            <Combobox<PlatformFilter>
              id="builds-filter-platform"
              value={platformFilter}
              onChange={onPlatformChange}
              options={PLATFORM_OPTIONS}
            />
          </div>
        </div>
      )}
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
