import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, cn } from "@mobileflow/ui";
import { CircleCheck, CircleX, Loader2, Play, Server, StopCircle } from "lucide-react";
import {
  ApiError,
  api,
  type DeployJobRow,
  type DeployJobState,
  type DeployLogLine,
} from "../api/client";
import { LogView } from "../components/LogView";
import { formatFullDate, relativeTime } from "../lib/dates";

/**
 * Runs this repo's deploy scripts from the locally-running API and streams the
 * output here, so pushing build tooling to a host doesn't need a terminal.
 *
 * Log transport mirrors the build detail page: a WebSocket while a job runs,
 * with a polling fallback that engages only when the socket isn't connected —
 * so a dropped socket degrades to slower updates instead of a frozen log.
 */
export function AdminDeployPage() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targetsQ = useQuery({
    queryKey: ["admin-deploy-targets"],
    queryFn: () => api.admin.deployTargets(),
  });

  const jobsQ = useQuery({
    queryKey: ["admin-deploy-jobs"],
    queryFn: () => api.admin.deployJobs(),
    // Cheap poll so a job started in another tab shows up, and so the list's
    // state badges settle after a run ends.
    refetchInterval: 4000,
  });

  const jobs = jobsQ.data?.jobs ?? [];
  const runningId = jobsQ.data?.runningId ?? null;

  // Default the selection to whatever is running, else the newest job.
  useEffect(() => {
    if (selectedId && jobs.some((j) => j.id === selectedId)) return;
    setSelectedId(runningId ?? jobs[0]?.id ?? null);
  }, [jobs, runningId, selectedId]);

  const run = useMutation({
    mutationFn: (targetId: string) => api.admin.runDeploy(targetId),
    onSuccess: (job) => {
      setError(null);
      setSelectedId(job.id);
      void qc.invalidateQueries({ queryKey: ["admin-deploy-jobs"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not start deploy"),
  });

  const cancel = useMutation({
    mutationFn: (jobId: string) => api.admin.cancelDeploy(jobId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin-deploy-jobs"] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not cancel deploy"),
  });

  const disabled = targetsQ.data ? !targetsQ.data.enabled : false;

  return (
    <div className="page admin-deploy-page">
      <div className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">Deploy</h1>
          <p className="text-help">
            Runs this checkout's deploy scripts on the machine hosting the API and streams their
            output. Meant for local development.
          </p>
        </div>
      </div>

      {disabled && (
        <div className="builds-status is-error">
          Local deploy is turned off on this API. It shells out to deploy scripts, so it stays
          development-only unless <code>ADMIN_LOCAL_DEPLOY=true</code> is set deliberately.
        </div>
      )}
      {error && <p className="text-error">{error}</p>}
      {targetsQ.error && (
        <div className="builds-status is-error">{(targetsQ.error as ApiError).message}</div>
      )}

      {/* ─── Targets ──────────────────────────────────────────────────────── */}
      <div className="admin-deploy-targets">
        {targetsQ.data?.targets.map((t) => (
          <div key={t.id} className="admin-deploy-target">
            <span className="admin-deploy-target__icon" aria-hidden>
              <Server size={16} />
            </span>
            <div className="admin-deploy-target__text">
              <div className="admin-deploy-target__label">{t.label}</div>
              <div className="admin-deploy-target__desc">{t.description}</div>
              <code className="plan-card__id">{t.command}</code>
              {!t.available && (
                <p className="text-error">Script not found in this checkout — nothing to run.</p>
              )}
            </div>
            <Button
              onClick={() => run.mutate(t.id)}
              loading={run.isPending && run.variables === t.id}
              disabled={disabled || !t.available || !!runningId || run.isPending}
            >
              <Play size={14} style={{ marginRight: 6 }} aria-hidden />
              {runningId ? "Busy" : "Deploy"}
            </Button>
          </div>
        ))}
        {targetsQ.data && targetsQ.data.targets.length === 0 && (
          <div className="empty-state">
            <div className="empty-state__title">No deploy targets</div>
          </div>
        )}
      </div>

      {/* ─── Runs + log ───────────────────────────────────────────────────── */}
      <div className="admin-deploy-layout">
        <aside className="admin-deploy-runs">
          <div className="app-rail-section-title">Recent runs</div>
          {jobs.length === 0 && <div className="builds-status">Nothing has run yet.</div>}
          {jobs.map((j) => (
            <button
              key={j.id}
              type="button"
              className={cn("admin-deploy-run", selectedId === j.id && "is-active")}
              onClick={() => setSelectedId(j.id)}
            >
              <StateIcon state={j.state} />
              <span className="admin-deploy-run__main">
                <span className="admin-deploy-run__label">{j.targetLabel}</span>
                <span
                  className="admin-deploy-run__time tooltip-wrap"
                  aria-label={formatFullDate(j.startedAt)}
                >
                  {relativeTime(j.startedAt)}
                  <span className="tooltip-bubble" role="tooltip">
                    {formatFullDate(j.startedAt)}
                  </span>
                </span>
              </span>
            </button>
          ))}
        </aside>

        <section className="admin-deploy-log">
          {selectedId ? (
            <JobPanel
              jobId={selectedId}
              onCancel={() => cancel.mutate(selectedId)}
              canceling={cancel.isPending}
              onFinished={() => void qc.invalidateQueries({ queryKey: ["admin-deploy-jobs"] })}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-state__title">No run selected</div>
              <p className="text-help">Start a deploy above to watch it here.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── One run: snapshot + live stream ─────────────────────────────────────────

function JobPanel({
  jobId,
  onCancel,
  canceling,
  onFinished,
}: {
  jobId: string;
  onCancel: () => void;
  canceling: boolean;
  onFinished: () => void;
}) {
  const [job, setJob] = useState<DeployJobRow | null>(null);
  const [lines, setLines] = useState<DeployLogLine[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  // Highest line seq we hold, so the polling fallback asks only for the delta.
  const seqRef = useRef(0);
  const finishedRef = useRef(false);

  // Reset when switching runs — otherwise the previous job's lines bleed in
  // before the new snapshot lands.
  useEffect(() => {
    setJob(null);
    setLines([]);
    seqRef.current = 0;
    finishedRef.current = false;
  }, [jobId]);

  // Filtered by seq, not just concatenated: the polling fallback fires once
  // before the socket finishes opening, so the same lines can arrive twice.
  const appendLines = (incoming: DeployLogLine[]) => {
    const fresh = incoming.filter((l) => l.seq > seqRef.current);
    if (fresh.length === 0) return;
    seqRef.current = fresh[fresh.length - 1]!.seq;
    setLines((prev) => [...prev, ...fresh]);
  };

  // Snapshot + live stream.
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${window.location.host}/api/admin/deploy/jobs/${encodeURIComponent(jobId)}/stream`,
    );
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);
    ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data)) as
        | { type: "snapshot"; job: DeployJobRow }
        | { type: "line"; line: DeployLogLine }
        | { type: "state"; state: DeployJobState; exitCode: number | null; endedAt: string | null }
        | { type: "error"; message: string };
      if (msg.type === "snapshot") {
        setJob(msg.job);
        setLines(msg.job.lines ?? []);
        const last = msg.job.lines?.[msg.job.lines.length - 1];
        seqRef.current = last?.seq ?? 0;
      } else if (msg.type === "line") {
        appendLines([msg.line]);
      } else if (msg.type === "state") {
        setJob((prev) =>
          prev ? { ...prev, state: msg.state, exitCode: msg.exitCode, endedAt: msg.endedAt } : prev,
        );
        if (!finishedRef.current) {
          finishedRef.current = true;
          onFinished();
        }
      }
    };
    return () => ws.close();
    // onFinished is a stable-enough callback from the parent; re-subscribing on
    // every render would tear the socket down mid-stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // Fallback: only polls while the socket is down and the job is unfinished.
  const pollQ = useQuery({
    queryKey: ["admin-deploy-job", jobId, "poll"],
    queryFn: () => api.admin.deployJob(jobId, seqRef.current || undefined),
    enabled: !wsConnected,
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state === "running" || state === undefined ? 1500 : false;
    },
  });

  useEffect(() => {
    const data = pollQ.data;
    if (!data) return;
    setJob((prev) => ({ ...(prev ?? data), ...data, lines: undefined }));
    appendLines(data.lines ?? []);
    if (data.state !== "running" && !finishedRef.current) {
      finishedRef.current = true;
      onFinished();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pollQ.data]);

  const raw = useMemo(
    () => lines.map((l) => (l.stream === "system" ? `» ${l.text}` : l.text)).join("\n"),
    [lines],
  );

  if (!job) return <div className="builds-status">Loading run…</div>;

  return (
    <>
      <div className="admin-deploy-log__header">
        <StateIcon state={job.state} />
        <div className="admin-deploy-log__meta">
          <span className="admin-deploy-log__title">{job.targetLabel}</span>
          <code className="plan-card__id">{job.command}</code>
        </div>
        <span className="text-help">
          {job.state === "running"
            ? wsConnected
              ? "streaming"
              : "polling"
            : `${job.state}${job.exitCode != null ? ` · exit ${job.exitCode}` : ""}`}
        </span>
        {job.state === "running" && (
          <Button variant="outline" className="btn-danger-outline" onClick={onCancel} loading={canceling}>
            <StopCircle size={14} style={{ marginRight: 6 }} aria-hidden />
            Cancel
          </Button>
        )}
      </div>

      {job.truncated && (
        <p className="text-help">
          Output was long — only the most recent lines are kept.
        </p>
      )}

      <LogView raw={raw} className="admin-deploy-log__body" empty="Waiting for output…" />
    </>
  );
}

function StateIcon({ state }: { state: DeployJobState }) {
  if (state === "running") {
    return <Loader2 size={14} className="is-spinning status-icon" aria-label="Running" />;
  }
  if (state === "succeeded") {
    return <CircleCheck size={14} className="status-icon is-success" aria-label="Succeeded" />;
  }
  return (
    <CircleX
      size={14}
      className="status-icon is-error"
      aria-label={state === "canceled" ? "Canceled" : "Failed"}
    />
  );
}
