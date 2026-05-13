import { useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Combobox } from "@mobileflow/ui";
import { ArrowLeft, Check, GitBranch } from "lucide-react";
import {
  ApiError,
  api,
  type BuildRow,
  type BuildTarget,
} from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";

const PLATFORM_META: Record<BuildTarget, { label: string; iconBg: string; icon: JSX.Element }> = {
  ios: { label: "iOS", iconBg: "#0a0a0a", icon: <AppleIcon /> },
  android: { label: "Android", iconBg: "#34a853", icon: <AndroidIcon /> },
  web: { label: "Web", iconBg: "#f7df1e", icon: <WebIcon /> },
};

export function NewDeploymentPage() {
  const { appId } = useParams();
  const [params] = useSearchParams();
  const buildId = params.get("buildId") ?? "";

  return buildId ? (
    <ConfigureDeployment appId={appId!} buildId={buildId} />
  ) : (
    <SelectBuild appId={appId!} />
  );
}

// ─── Step 1: Select build ────────────────────────────────────────────────────

function SelectBuild({ appId }: { appId: string }) {
  const navigate = useNavigate();

  const buildsQ = useQuery({
    queryKey: ["builds", appId],
    queryFn: () => api.listBuilds(appId),
  });

  // Only deployable builds: succeeded, ios/android (web has no store), and
  // not already deployed to a destination (the inline-publish flow created a
  // deployment for those — surfacing them as "deployable again" is confusing
  // and they appear on the Deployments page already).
  const numbered = useMemo(() => {
    const list = buildsQ.data ?? [];
    const total = list.length;
    return list
      .map((b, i) => ({ build: b, number: total - i }))
      .filter(({ build }) =>
        build.status === "success" && (build.target === "ios" || build.target === "android"),
      );
  }, [buildsQ.data]);

  return (
    <div className="new-build-page">
      <button type="button" className="new-build-back" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>
      <header className="new-build-header">
        <h1 className="new-build-title">Create New Deployment</h1>
        <Steps activeStep="select" />
      </header>

      <div className="new-build-section">
        <p className="new-build-help">Select a build to deploy</p>

        {buildsQ.isLoading && <div className="builds-status">Loading builds…</div>}
        {buildsQ.error && (
          <div className="builds-status is-error">{(buildsQ.error as ApiError).message}</div>
        )}
        {!buildsQ.isLoading && !buildsQ.error && numbered.length === 0 && (
          <div className="builds-empty">
            <h2 className="builds-empty__title">No deployable builds yet</h2>
            <p className="builds-empty__body">Successful iOS or Android builds will appear here.</p>
          </div>
        )}

        {numbered.length > 0 && (
          <div className="deploy-build-table">
            <div className="deploy-build-table__head">
              <span>Build</span>
              <span>Platform</span>
              <span>Triggered by</span>
              <span>Commit</span>
            </div>
            {numbered.map(({ build, number }) => (
              <SelectableBuildRow
                key={build.id}
                build={build}
                number={number}
                onPick={() => navigate(`/app/${appId}/deploy/deployments/new?buildId=${build.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SelectableBuildRow({
  build,
  number,
  onPick,
}: {
  build: BuildRow;
  number: number;
  onPick: () => void;
}) {
  const platform = PLATFORM_META[build.target];
  const triggeredByName = build.triggeredByName || build.triggeredByEmail || "—";
  const triggeredByInitial = (triggeredByName || "?").trim().charAt(0).toUpperCase();
  const commitTitle = build.commitMessage?.split("\n")[0] || build.commitSha.slice(0, 6);
  const commitShort = build.commitSha.slice(0, 6);
  const fullDate = formatFullDate(build.createdAt);

  return (
    <button type="button" className="deploy-build-row" onClick={onPick}>
      <div className="deploy-build-row__id">#{number}</div>
      <div className="deploy-build-row__platform">
        <span className="deploy-build-row__platform-icon" style={{ background: platform.iconBg }}>
          {platform.icon}
        </span>
        <span>{platform.label}</span>
      </div>
      <div className="deploy-build-row__triggered">
        <span className="deploy-build-row__avatar">
          <span className="commit-row__avatar-fallback">{triggeredByInitial}</span>
        </span>
        <div className="deploy-build-row__triggered-meta">
          <span className="deploy-build-row__triggered-name">{triggeredByName}</span>
          <span
            className="tooltip-wrap deploy-build-row__triggered-date"
            tabIndex={0}
            aria-label={fullDate}
          >
            {relativeTime(build.createdAt)}
            <span className="tooltip-bubble" role="tooltip">{fullDate}</span>
          </span>
        </div>
      </div>
      <div className="deploy-build-row__commit">
        <span className="deploy-build-row__avatar">
          <span className="commit-row__avatar-fallback">C</span>
        </span>
        <div className="deploy-build-row__commit-meta">
          <div className="deploy-build-row__commit-line">
            <span className="deploy-build-row__commit-sha">{commitShort}</span>
            <span className="deploy-build-row__commit-msg">{commitTitle}</span>
          </div>
          <div className="deploy-build-row__commit-sub">
            <span className="tooltip-wrap" tabIndex={0} aria-label={fullDate}>
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
    </button>
  );
}

// ─── Step 2: Configure deployment ────────────────────────────────────────────

function ConfigureDeployment({ appId, buildId }: { appId: string; buildId: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [destinationId, setDestinationId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  // Use the cached builds list (populated by the select step) to compute the
  // sequential build number — cheap because react-query dedupes the request.
  const buildsQ = useQuery({
    queryKey: ["builds", appId],
    queryFn: () => api.listBuilds(appId),
  });
  const buildEntry = useMemo(() => {
    const list = buildsQ.data ?? [];
    const idx = list.findIndex((b) => b.id === buildId);
    if (idx === -1) return null;
    return { build: list[idx]!, number: list.length - idx };
  }, [buildsQ.data, buildId]);

  const destsQ = useQuery({
    queryKey: ["destinations", appId],
    queryFn: () => api.listDestinations(appId),
  });
  const matchingDestinations = useMemo(() => {
    if (!buildEntry) return [];
    const list = destsQ.data ?? [];
    if (buildEntry.build.target === "ios") {
      return list.filter((d) => d.type === "app_store" || d.type === "testflight");
    }
    if (buildEntry.build.target === "android") {
      return list.filter((d) => d.type === "play_store" || d.type === "play_internal");
    }
    return [];
  }, [buildEntry, destsQ.data]);

  const deploy = useMutation({
    mutationFn: () => api.createDeployment(appId, { buildId, destinationId }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ["deployments", appId] });
      // Return to the deployments list with the new deployment's log modal
      // auto-opened (DeploymentsPage reads ?open from the query string).
      navigate(`/app/${appId}/deploy/deployments?open=${created.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <div className="new-build-page">
      <button type="button" className="new-build-back" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>
      <header className="new-build-header">
        <h1 className="new-build-title">Create New Deployment</h1>
        <Steps activeStep="configure" />
      </header>

      {buildEntry ? (
        <SelectedBuildSummary
          build={buildEntry.build}
          number={buildEntry.number}
          onChange={() => navigate(`/app/${appId}/deploy/deployments/new`)}
        />
      ) : (
        <div className="builds-status">Looking up build…</div>
      )}

      <div className="new-build-section">
        <span className="new-build-label">Destination</span>
        <p className="new-build-help">Assign build to a store destination</p>
        {destsQ.isLoading ? (
          <div className="builds-status">Loading destinations…</div>
        ) : matchingDestinations.length > 0 ? (
          <Combobox
            value={destinationId}
            onChange={setDestinationId}
            options={[
              { value: "", label: "None" },
              ...matchingDestinations.map((d) => ({ value: d.id, label: d.name })),
            ]}
          />
        ) : (
          <Button
            variant="outline"
            onClick={() => navigate(`/app/${appId}/deploy/destinations`)}
          >
            Set up your first destination to store
          </Button>
        )}
        {matchingDestinations.length > 0 && (
          <Link to={`/app/${appId}/deploy/destinations`} className="new-build-link new-deploy-add-link">
            Create new destination to store
          </Link>
        )}
      </div>

      {error && <p className="new-build-error">{error}</p>}

      <div className="new-build-actions">
        <Button variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
        <Button
          onClick={() => deploy.mutate()}
          loading={deploy.isPending}
          disabled={!destinationId}
        >
          Deploy
        </Button>
      </div>
    </div>
  );
}

function SelectedBuildSummary({
  build,
  number,
  onChange,
}: {
  build: BuildRow;
  number: number;
  onChange: () => void;
}) {
  const platform = PLATFORM_META[build.target];
  const commitTitle = build.commitMessage?.split("\n")[0] || build.commitSha.slice(0, 6);
  const commitShort = build.commitSha.slice(0, 6);
  const triggeredByName = build.triggeredByName || build.triggeredByEmail || "—";
  return (
    <div className="deploy-build-summary">
      <span className="deploy-build-summary__id">#{number}</span>
      <span className="deploy-build-summary__platform">
        <span className="deploy-build-summary__platform-icon" style={{ background: platform.iconBg }}>
          {platform.icon}
        </span>
        <span>{platform.label}</span>
      </span>
      <span className="deploy-build-summary__commit">
        <span className="deploy-build-summary__avatar">
          <span className="commit-row__avatar-fallback">C</span>
        </span>
        <span className="deploy-build-summary__commit-meta">
          <span className="deploy-build-summary__commit-line">
            <span className="deploy-build-summary__commit-sha">{commitShort}</span>
            <span className="deploy-build-summary__commit-msg">{commitTitle}</span>
          </span>
          <span className="deploy-build-summary__commit-sub">
            {triggeredByName} · {relativeTime(build.createdAt)}{build.branch ? ` from ${build.branch}` : ""}
          </span>
        </span>
      </span>
      <button type="button" className="deploy-build-summary__change" onClick={onChange}>
        Change
      </button>
    </div>
  );
}

function Steps({ activeStep }: { activeStep: "select" | "configure" }) {
  return (
    <div className="new-build-steps">
      <span className={`new-build-step${activeStep === "select" ? " is-active" : " is-done"}`}>
        {activeStep === "configure" ? <Check size={14} className="new-build-step-check" /> : <span>1.</span>}
        <span> Select build</span>
      </span>
      <span className={`new-build-step${activeStep === "configure" ? " is-active" : ""}`}>
        2. Configure deployment
      </span>
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
