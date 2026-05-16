import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button } from "@mobileflow/ui";
import {
  CheckCircle2,
  Circle,
  Download,
  GitBranch,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import {
  ApiError,
  api,
  type BuildDetail,
  type BuildStepStatus,
  type BuildTarget,
} from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";
import { stackLabel, useStacks } from "../lib/stacks";

interface SnapshotEvent {
  type: "snapshot";
  build: BuildDetail;
  steps: BuildDetail["steps"];
  log: string;
}
interface LogEvent { type: "log"; line: string; offset: number }
interface StepEvent { type: "step"; name: string; status: BuildStepStatus; exitCode?: number }
interface StatusEvent {
  type: "status";
  status: BuildDetail["status"];
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}
interface ArtifactsEvent { type: "artifacts"; artifacts: { kind: string; url: string }[] }
type StreamEvent = SnapshotEvent | LogEvent | StepEvent | StatusEvent | ArtifactsEvent | { type: "error"; message: string };

const PLATFORM_META: Record<BuildTarget, { label: string; iconBg: string; icon: JSX.Element }> = {
  ios: { label: "iOS", iconBg: "#0a0a0a", icon: <AppleIcon /> },
  android: { label: "Android", iconBg: "#34a853", icon: <AndroidIcon /> },
  web: { label: "Web", iconBg: "#f7df1e", icon: <WebIcon /> },
};

const BUILD_TYPE_LABEL: Record<string, string> = {
  simulator: "Simulator",
  development: "Development",
  adhoc: "Ad Hoc",
  appstore: "App Store",
  debug: "Debug",
  release: "Release",
};

const DESTINATION_LABEL: Record<string, string> = {
  app_store: "App Store",
  play_store: "Play Store",
};

const ARTIFACT_LABEL: Record<string, string> = {
  ipa: "IPA",
  aab: "AAB",
  apk: "APK",
  zip: "ZIP",
  dsym: "dSYM",
};

export function BuildPage() {
  const { buildId, appId } = useParams();
  const qc = useQueryClient();
  const stacksQ = useStacks();
  const [logBuf, setLogBuf] = useState("");
  const [wsConnected, setWsConnected] = useState(false);
  const offsetRef = useRef(0);

  // WS-driven snapshot — replaced by polling if WS fails or is not authorized.
  const [snapshot, setSnapshot] = useState<BuildDetail | null>(null);

  // Polling fallback (only activates when WS fails / disconnects on a live build).
  const pollQ = useQuery<BuildDetail>({
    queryKey: ["build", buildId, "poll"],
    queryFn: async () => {
      const res = await api.getBuild(buildId!, offsetRef.current);
      offsetRef.current = res.log.offset + res.log.tail.length;
      if (res.log.tail) setLogBuf((prev) => prev + res.log.tail);
      return res;
    },
    enabled: !!buildId && !wsConnected,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "queued" || s === "running" ? 1000 : false;
    },
  });

  useEffect(() => {
    offsetRef.current = 0;
    setLogBuf("");
    setSnapshot(null);
  }, [buildId]);

  // Open WebSocket
  useEffect(() => {
    if (!buildId) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/builds/${buildId}/stream`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (msg) => {
      let evt: StreamEvent;
      try {
        evt = JSON.parse(msg.data) as StreamEvent;
      } catch {
        return;
      }
      if (evt.type === "snapshot") {
        setSnapshot({ ...evt.build, steps: evt.steps, log: { offset: 0, length: evt.log.length, tail: "" } });
        setLogBuf(evt.log);
        offsetRef.current = evt.log.length;
      } else if (evt.type === "log") {
        setLogBuf((prev) => prev + evt.line);
        offsetRef.current = evt.offset;
      } else if (evt.type === "step") {
        setSnapshot((s) =>
          s
            ? {
                ...s,
                steps: s.steps.map((step) =>
                  step.name === evt.name ? { ...step, status: evt.status, exitCode: evt.exitCode ?? step.exitCode } : step,
                ),
              }
            : s,
        );
      } else if (evt.type === "status") {
        setSnapshot((s) =>
          s
            ? {
                ...s,
                status: evt.status,
                errorMessage: evt.errorMessage ?? s.errorMessage,
                // Merge timestamps when the worker provides them so the live
                // duration ticker can start counting even if the initial
                // snapshot pre-dated the claim (startedAt was still null).
                startedAt: evt.startedAt ?? s.startedAt,
                finishedAt: evt.finishedAt ?? s.finishedAt,
              }
            : s,
        );
      } else if (evt.type === "artifacts") {
        setSnapshot((s) => (s ? { ...s, artifacts: evt.artifacts } : s));
      }
    };
    return () => ws.close();
  }, [buildId]);

  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await api.cancelBuild(buildId!);
    } catch (err) {
      if (!(err instanceof ApiError) || err.message !== "Build is already finished") throw err;
    } finally {
      void qc.invalidateQueries({ queryKey: ["build", buildId] });
    }
  };

  // Prefer live WS snapshot while the socket is open; otherwise trust polling.
  const b = wsConnected ? (snapshot ?? pollQ.data) : (pollQ.data ?? snapshot);

  // Cached builds list (already populated by BuildsPage); used to compute the
  // sequential build number. Cheap because react-query dedupes the request.
  const effectiveAppId = appId ?? b?.appId;
  const buildsListQ = useQuery({
    queryKey: ["builds", effectiveAppId],
    queryFn: () => api.listBuilds(effectiveAppId!),
    enabled: !!effectiveAppId,
    staleTime: 30_000,
  });
  const buildNumber = useMemo(() => {
    const list = buildsListQ.data;
    if (!list || !b) return null;
    const idx = list.findIndex((row) => row.id === b.id);
    return idx === -1 ? null : list.length - idx;
  }, [buildsListQ.data, b]);

  // Environment lookup — Build only carries environmentId; we resolve to a name.
  const envsQ = useQuery({
    queryKey: ["environments", effectiveAppId],
    queryFn: () => api.listEnvironments(effectiveAppId!),
    enabled: !!effectiveAppId && !!b?.environmentId,
    staleTime: 60_000,
  });
  const environmentName = useMemo(() => {
    if (!b?.environmentId) return null;
    return envsQ.data?.find((e) => e.id === b.environmentId)?.name ?? null;
  }, [envsQ.data, b?.environmentId]);

  // Destinations for the manual "Deploy binary" path. Only fetched when the
  // build is finished and lacks an auto-deploy destination, since this is the
  // only state where the button is offered.
  const destsQ = useQuery({
    queryKey: ["destinations", effectiveAppId],
    queryFn: () => api.listDestinations(effectiveAppId!),
    enabled: !!effectiveAppId && b?.status === "success" && !b?.autoDeployDestinationId,
    staleTime: 60_000,
  });
  const matchingDestinations = useMemo(() => {
    if (!b || !destsQ.data) return [];
    if (b.target === "ios") return destsQ.data.filter((d) => d.type === "app_store" || d.type === "testflight");
    if (b.target === "android") return destsQ.data.filter((d) => d.type === "play_store" || d.type === "play_internal");
    return [];
  }, [b, destsQ.data]);

  const navigate = useNavigate();
  const deployMut = useMutation({
    mutationFn: (destinationId: string) =>
      api.createDeployment(effectiveAppId!, { buildId: b!.id, destinationId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["build", buildId] });
      void qc.invalidateQueries({ queryKey: ["deployments", effectiveAppId] });
      navigate(`/app/${effectiveAppId}/deploy/deployments`);
    },
  });

  // Auto-scroll logs to the bottom when new content arrives, unless the user
  // has scrolled away from the bottom.
  const logRef = useRef<HTMLPreElement>(null);
  const stuckToBottomRef = useRef(true);
  // True for the brief window between our programmatic scrollTop write and the
  // resulting scroll event — keeps the user-scroll detector from mistakenly
  // disengaging auto-scroll on our own writes.
  const programmaticScrollRef = useRef(false);
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (!stuckToBottomRef.current) return;
    // rAF so the scroll happens after layout has settled with the new content.
    // Without it, scrollHeight occasionally reflects the pre-paint height and
    // we end up one frame short of the actual bottom.
    const raf = requestAnimationFrame(() => {
      const e = logRef.current;
      if (!e) return;
      programmaticScrollRef.current = true;
      e.scrollTop = e.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [logBuf]);
  const onLogScroll = () => {
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    const el = logRef.current;
    if (!el) return;
    // 24px tolerance covers scrollbar thumb height, partial-line wraps, and
    // small layout-shift jitter. The previous 4px was tight enough that any
    // wheel-tick away from the bottom would permanently disengage auto-scroll
    // until the user re-snapped to the exact bottom pixel.
    stuckToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  // Live ticking duration while the build is running.
  const [, setTick] = useState(0);
  useEffect(() => {
    const live = b?.status === "queued" || b?.status === "running";
    if (!live) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [b?.status]);

  if (!b && pollQ.isLoading && !wsConnected) {
    return <div className="build-detail__status">Loading…</div>;
  }
  if (pollQ.error && !b) {
    return <div className="build-detail__status is-error">{(pollQ.error as ApiError).message}</div>;
  }
  if (!b) return <div className="build-detail__status">Connecting…</div>;

  const live = b.status === "queued" || b.status === "running";
  const platform = PLATFORM_META[b.target];
  const shortId = b.id.slice(0, 8);
  const shortSha = b.commitSha.slice(0, 7);
  const headerLabel = buildNumber != null ? `Build #${buildNumber}` : `Build ${shortId}`;
  const dep = b.deployments?.[0] ?? null;
  const triggeredBy = b.triggeredByName || b.triggeredByEmail || "—";
  const triggeredInitial = triggeredBy.trim().charAt(0).toUpperCase() || "?";
  const durationText = formatDuration(b.startedAt, b.finishedAt, b.createdAt, live);
  const buildTypeLabel = b.buildType ? (BUILD_TYPE_LABEL[b.buildType] ?? b.buildType) : null;
  const showDeployment = !!dep;
  // Manual deploy is only offered when the build succeeded, didn't already
  // request an auto-deploy at start time, and has no deployment yet. Web
  // builds don't have store destinations.
  const showDeployButton =
    b.status === "success" &&
    !b.autoDeployDestinationId &&
    !dep &&
    b.target !== "web";
  const showCert = !!b.certificateLabel;
  const showEnv = !!b.environmentId;

  return (
    <div className="build-detail">
      <header className="build-detail__header">
        <div className="build-detail__header-left">
          <Link to={appId ? `/app/${appId}/build/builds` : "#"} className="build-detail__back">
            ← Builds
          </Link>
          <div className="build-detail__title-row">
            <h1 className="build-detail__title">{headerLabel}</h1>
            <StatusBadge status={b.status} />
            <span className={`build-detail__live-dot is-${wsConnected ? "live" : "polling"}`} aria-hidden />
          </div>
          <p className="build-detail__subtitle">
            <span className="build-detail__platform-chip" style={{ background: platform.iconBg }}>
              {platform.icon}
            </span>
            <span>{platform.label}</span>
            <span className="build-detail__dot" aria-hidden>·</span>
            <code className="build-detail__sha">{shortSha}</code>
            {b.branch && (
              <>
                <span className="build-detail__dot" aria-hidden>·</span>
                <span className="build-detail__branch">
                  <GitBranch size={12} aria-hidden /> {b.branch}
                </span>
              </>
            )}
          </p>
        </div>
        {live && (
          <Button variant="destructive" onClick={cancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel build"}
          </Button>
        )}
      </header>

      <section className="pipeline-tracker" aria-label="Build pipeline">
        <ol className="pipeline-tracker__list">
          {b.steps.map((s, i) => (
            <li
              key={s.id ?? s.name}
              className={`pipeline-step is-${s.status}`}
              title={s.exitCode != null ? `${s.status} (exit ${s.exitCode})` : s.status}
            >
              <span className="pipeline-step__icon" aria-hidden>
                <StepIcon status={s.status} />
              </span>
              <span className="pipeline-step__name">{s.name}</span>
              {i < b.steps.length - 1 && <span className="pipeline-step__connector" aria-hidden />}
            </li>
          ))}
        </ol>
      </section>

      <div className="build-detail__body">
        <section className="build-logs" aria-label="Build logs">
          <header className="build-logs__header">
            <h2 className="build-logs__title">Logs</h2>
            <span className="build-logs__count">{logBuf ? `${logBuf.length.toLocaleString()} chars` : ""}</span>
          </header>
          <pre ref={logRef} onScroll={onLogScroll} className="build-logs__pre">
            {logBuf || <span className="build-logs__empty">(no output yet)</span>}
          </pre>
          {b.errorMessage && (
            <div className="build-logs__error">
              <span className="build-logs__error-label">Error</span>
              <pre className="build-logs__error-body">{b.errorMessage}</pre>
            </div>
          )}
        </section>

        <aside className="build-side-panel" aria-label="Build details">
          <DetailRow label="Duration" value={durationText} />
          <DetailRow label="Build ID" value={<code className="is-mono">{shortId}</code>} />
          <DetailRow
            label="Platform / Type"
            value={
              <span className="build-side-panel__platform">
                <span className="build-side-panel__platform-icon" style={{ background: platform.iconBg }}>
                  {platform.icon}
                </span>
                {platform.label}
                {buildTypeLabel && <span className="build-side-panel__muted"> · {buildTypeLabel}</span>}
              </span>
            }
          />
          <DetailRow label="Build Stack" value={stackLabel(stacksQ.data, b.target, b.stackId)} />
          {showDeployment && (
            <DetailRow
              label="Deployment"
              value={
                <span className="build-side-panel__deploy">
                  <span>{dep!.destinationName ?? "—"}</span>
                  {dep!.destinationType && (
                    <span className="build-side-panel__muted">
                      {DESTINATION_LABEL[dep!.destinationType] ?? dep!.destinationType}
                    </span>
                  )}
                </span>
              }
            />
          )}
          {showDeployButton && (
            <DetailRow
              label="Deployment"
              value={
                matchingDestinations.length > 0 ? (
                  <Button
                    variant="outline"
                    onClick={() => deployMut.mutate(matchingDestinations[0]!.id)}
                    loading={deployMut.isPending}
                  >
                    Deploy binary
                  </Button>
                ) : (
                  <span className="build-side-panel__muted">
                    No {b.target === "ios" ? "App Store" : "Google Play"} destination —{" "}
                    <Link to={`/app/${effectiveAppId}/deploy/destinations`} className="build-side-panel__link">
                      add one
                    </Link>
                  </span>
                )
              }
            />
          )}
          {b.artifacts && b.artifacts.length > 0 && (
            <DetailRow
              label="Artifacts"
              value={
                <ul className="build-side-panel__artifacts">
                  {b.artifacts.map((a) => (
                    <li key={a.url}>
                      <a href={a.url} className="build-side-panel__artifact-link">
                        <Download size={13} aria-hidden />
                        Download {ARTIFACT_LABEL[a.kind] ?? a.kind.toUpperCase()}
                      </a>
                    </li>
                  ))}
                </ul>
              }
            />
          )}
          <DetailRow
            label="Commit"
            value={
              <span className="build-side-panel__commit">
                <code className="build-side-panel__sha">{shortSha}</code>
                {b.commitMessage && (
                  <span className="build-side-panel__commit-msg">{b.commitMessage.split("\n")[0]}</span>
                )}
                {b.branch && (
                  <span className="build-side-panel__muted">
                    <GitBranch size={11} aria-hidden /> {b.branch}
                  </span>
                )}
              </span>
            }
          />
          <DetailRow
            label="Triggered By"
            value={
              <span className="build-side-panel__user">
                <span className="build-side-panel__avatar">{triggeredInitial}</span>
                <span>
                  <span className="build-side-panel__user-name">{triggeredBy}</span>
                  <span
                    className="tooltip-wrap build-side-panel__muted"
                    tabIndex={0}
                    aria-label={formatFullDate(b.createdAt)}
                  >
                    {relativeTime(b.createdAt)}
                    <span className="tooltip-bubble" role="tooltip">{formatFullDate(b.createdAt)}</span>
                  </span>
                </span>
              </span>
            }
          />
          {showCert && <DetailRow label="Signing Certificate" value={b.certificateLabel!} />}
          {showEnv && (
            <DetailRow
              label="Environment"
              value={environmentName ?? <span className="build-side-panel__muted">Loading…</span>}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="build-side-panel__row">
      <div className="build-side-panel__label">{label}</div>
      <div className="build-side-panel__value">{value}</div>
    </div>
  );
}

function StepIcon({ status }: { status: BuildStepStatus }) {
  switch (status) {
    case "running":
      return <Loader2 size={16} className="pipeline-step__spinner" />;
    case "success":
      return <CheckCircle2 size={16} />;
    case "failed":
      return <XCircle size={16} />;
    case "skipped":
      return <MinusCircle size={16} />;
    case "pending":
    default:
      return <Circle size={16} />;
  }
}

function StatusBadge({ status }: { status: BuildDetail["status"] }) {
  return <span className={`build-status-badge is-${status}`}>{status}</span>;
}

// Returns a human-readable duration. While the build is live we tick once a
// second (via the parent effect) so this re-renders with the latest value.
function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
  createdAt: string,
  live: boolean,
): string {
  const start = startedAt ?? (live ? null : createdAt);
  if (!start) return "—";
  const startMs = new Date(start).getTime();
  const endMs = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "—";
  let sec = Math.max(0, Math.round((endMs - startMs) / 1000));
  const hr = Math.floor(sec / 3600);
  sec -= hr * 3600;
  const min = Math.floor(sec / 60);
  sec -= min * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hr > 0 ? `${hr}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
}

function AppleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.665 16.811a10.316 10.316 0 0 1-1.021 1.837c-.537.767-.978 1.297-1.316 1.592-.525.482-1.089.73-1.692.744-.432 0-.954-.123-1.562-.373-.61-.249-1.17-.371-1.683-.371-.537 0-1.113.122-1.73.371-.616.25-1.114.381-1.495.393-.577.025-1.154-.229-1.729-.764-.367-.318-.83-.866-1.388-1.645-.598-.83-1.087-1.79-1.467-2.876-.413-1.17-.62-2.305-.62-3.402 0-1.257.272-2.34.815-3.249.428-.728 1-1.301 1.715-1.72.713-.42 1.485-.633 2.314-.647.46 0 1.063.142 1.81.422.745.28 1.225.422 1.435.422.158 0 .69-.165 1.594-.493.857-.305 1.58-.43 2.17-.382 1.605.13 2.81.764 3.612 1.905-1.434.873-2.144 2.094-2.13 3.66.013 1.222.451 2.238 1.314 3.046.39.371.825.658 1.31.864-.105.305-.215.598-.331.879zm-3.873-15.43c0 .938-.342 1.815-1.027 2.628-.825.964-1.823 1.522-2.906 1.434a2.93 2.93 0 0 1-.022-.354c0-.9.392-1.864 1.087-2.654.347-.4.787-.733 1.32-1 .533-.262 1.037-.408 1.512-.434.014.13.036.26.036.38z" />
    </svg>
  );
}

function AndroidIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.523 15.341a1.04 1.04 0 1 1 0-2.082 1.04 1.04 0 0 1 0 2.082m-11.046 0a1.04 1.04 0 1 1 0-2.082 1.04 1.04 0 0 1 0 2.082m11.42-6.02 2.078-3.6a.43.43 0 1 0-.745-.43l-2.103 3.643a13.05 13.05 0 0 0-5.127-1.04c-1.842 0-3.59.378-5.127 1.04L4.77 5.291a.43.43 0 1 0-.745.43l2.078 3.6C2.554 11.218 0 14.696 0 18.708h24c0-4.012-2.554-7.49-6.103-9.387" />
    </svg>
  );
}

function WebIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <text x="12" y="17" textAnchor="middle" fontSize="10" fontFamily="Arial, sans-serif" fontWeight="700" fill="#0a0a0a">JS</text>
    </svg>
  );
}
