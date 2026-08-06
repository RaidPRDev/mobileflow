import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
  Loading,
} from "@mobileflow/ui";
import {
  Check,
  CircleCheck,
  CircleX,
  Copy,
  Globe,
  Info,
  Loader2,
  Play,
  Server,
  StopCircle,
  Terminal,
} from "lucide-react";
import {
  ApiError,
  api,
  type DeployJobRow,
  type DeployJobState,
  type DeployLogLine,
  type DeployTargetRow,
} from "../api/client";
import { LogView } from "../components/LogView";
import { formatFullDate, relativeTime } from "../lib/dates";

/**
 * Runs this repo's deploy scripts from the locally-running API and streams the
 * output here, so shipping a release — or pushing build tooling to a host —
 * doesn't need a terminal.
 *
 * Targets come in two flavours, one per tab. **Server** runs the full release
 * pipeline (zip → upload → build both images on the swarm → rolling deploy), so
 * it is confirmed before it starts and the confirmation is re-checked by the
 * API. **Build tools** pushes the RaidX scripts to the iOS/Android build hosts.
 *
 * The run history below the tabs is filtered to the active tab — a tab only
 * ever shows its own runs — and a spinner on the other tab's trigger keeps a
 * job running over there visible.
 *
 * Log transport mirrors the build detail page: a WebSocket while a job runs,
 * with a polling fallback that engages only when the socket isn't connected —
 * so a dropped socket degrades to slower updates instead of a frozen log.
 */

type TabKey = "server" | "tooling";

/** Targets are grouped by kind; "production" is what the Server tab deploys. */
function tabForKind(kind: DeployTargetRow["kind"]): TabKey {
  return kind === "production" ? "server" : "tooling";
}

export function AdminDeployPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("server");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<DeployTargetRow | null>(null);

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
  const allTargets = targetsQ.data?.targets ?? [];

  // Runs carry a targetId, not a kind, so map one to the other to split the
  // history per tab.
  const tabByTargetId = useMemo(
    () => new Map(allTargets.map((t) => [t.id, tabForKind(t.kind)])),
    [allTargets],
  );
  const tabOf = (targetId: string): TabKey => tabByTargetId.get(targetId) ?? "tooling";
  const tabJobs = jobs.filter((j) => tabOf(j.targetId) === tab);
  const runningJob = runningId ? jobs.find((j) => j.id === runningId) : undefined;
  const runningTab = runningJob ? tabOf(runningJob.targetId) : null;

  // Default the selection to whatever is running in this tab, else its newest
  // run. Switching tabs re-runs this and picks that tab's own selection.
  useEffect(() => {
    if (selectedId && tabJobs.some((j) => j.id === selectedId)) return;
    const runningHere = runningTab === tab ? runningId : null;
    setSelectedId(runningHere ?? tabJobs[0]?.id ?? null);
  }, [tabJobs, runningId, runningTab, tab, selectedId]);

  const run = useMutation({
    mutationFn: (target: DeployTargetRow) =>
      api.admin.runDeploy(target.id, target.kind === "production"),
    onSuccess: (job) => {
      setError(null);
      setConfirmTarget(null);
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
  const serverTargets = allTargets.filter((t) => tabForKind(t.kind) === "server");
  const toolingTargets = allTargets.filter((t) => tabForKind(t.kind) === "tooling");

  function startTarget(target: DeployTargetRow) {
    // Production asks first; everything else is a script push and goes straight
    // through.
    if (target.kind === "production") setConfirmTarget(target);
    else run.mutate(target);
  }

  return (
    <div className="page admin-deploy-page">
      <div className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">Deploy</h1>
          <p className="text-help">
            Runs this checkout's deploy scripts on the machine hosting the API and streams the
            output below.
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
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="admin-deploy-tabs">
        <TabsList>
          <TabsTrigger value="server">
            <span className="admin-deploy-tab">
              <Globe size={14} aria-hidden />
              Server
              {runningTab === "server" && (
                <Loader2 size={12} className="is-spinning" aria-label="Deploy running" />
              )}
            </span>
          </TabsTrigger>
          <TabsTrigger value="tooling">
            <span className="admin-deploy-tab">
              <Server size={14} aria-hidden />
              Build tools
              {runningTab === "tooling" && (
                <Loader2 size={12} className="is-spinning" aria-label="Deploy running" />
              )}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="server">
          <TargetList
            targets={serverTargets}
            emptyLabel="No server deploy target is configured in this checkout."
            disabled={disabled}
            busy={!!runningId}
            pendingId={run.isPending ? run.variables?.id ?? null : null}
            onRun={startTarget}
          />
        </TabsContent>

        <TabsContent value="tooling">
          <TargetList
            targets={toolingTargets}
            emptyLabel="No build-tooling scripts were found in this checkout."
            disabled={disabled}
            busy={!!runningId}
            pendingId={run.isPending ? run.variables?.id ?? null : null}
            onRun={startTarget}
            grid
          />
        </TabsContent>
      </Tabs>

      {/* ─── Runs + log ───────────────────────────────────────────────────── */}
      <div className="admin-deploy-layout">
        <aside className="admin-deploy-runs">
          <div className="admin-deploy-runs__title">Recent runs</div>
          <div className="admin-deploy-runs__list">
            {tabJobs.length === 0 && (
              <p className="admin-deploy-runs__empty">
                {tab === "server" ? "No deploys yet." : "Nothing has run yet."}
              </p>
            )}
            {tabJobs.map((j) => (
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
          </div>
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
            // Deliberately not `.empty-state`: that centers a fixed-width block
            // in the page flow, which left this panel looking like a stray box
            // next to the runs list. This fills the panel instead.
            <div className="admin-deploy-log__placeholder">
              <Terminal size={20} aria-hidden />
              <p className="admin-deploy-log__placeholder-title">No run selected</p>
              <p className="text-help">
                {tab === "server"
                  ? "Deploy to live above to watch the pipeline here."
                  : "Start a script push above to watch it here."}
              </p>
            </div>
          )}
        </section>
      </div>

      {confirmTarget && (
        <ConfirmDeployDialog
          target={confirmTarget}
          pending={run.isPending}
          onCancel={() => {
            if (!run.isPending) setConfirmTarget(null);
          }}
          onConfirm={() => run.mutate(confirmTarget)}
        />
      )}
    </div>
  );
}

// ─── Targets ─────────────────────────────────────────────────────────────────

function TargetList({
  targets,
  emptyLabel,
  disabled,
  busy,
  pendingId,
  onRun,
  grid = false,
}: {
  targets: DeployTargetRow[];
  emptyLabel: string;
  disabled: boolean;
  busy: boolean;
  pendingId: string | null;
  onRun: (target: DeployTargetRow) => void;
  // Side-by-side cards (tooling) instead of the stacked full-width rows the
  // production target keeps.
  grid?: boolean;
}) {
  if (targets.length === 0) {
    return <p className="admin-deploy-targets__empty">{emptyLabel}</p>;
  }
  return (
    <div className={cn("admin-deploy-targets", grid && "is-grid")}>
      {targets.map((t) => (
        <TargetCard
          key={t.id}
          target={t}
          busy={busy}
          pending={pendingId === t.id}
          disabled={disabled || !t.available || busy || pendingId !== null}
          onRun={() => onRun(t)}
        />
      ))}
    </div>
  );
}

function TargetCard({
  target,
  busy,
  pending,
  disabled,
  onRun,
}: {
  target: DeployTargetRow;
  busy: boolean;
  pending: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  const isProduction = target.kind === "production";
  return (
    <div className={cn("admin-deploy-target", isProduction && "is-production")}>
      <span className="admin-deploy-target__icon" aria-hidden>
        {isProduction ? <Globe size={16} /> : <Server size={16} />}
      </span>
      <div className="admin-deploy-target__text">
        <div className="admin-deploy-target__label">
          {target.label}
          {isProduction && <span className="admin-deploy-target__tag">production</span>}
        </div>
        {/* Description and exact argv live in the info tooltip; the card face
            keeps only what identifies the destination. */}
        {(target.stack || target.url) && (
          <div className="admin-deploy-target__meta">
            {target.stack && (
              <span>
                stack <code>{target.stack}</code>
              </span>
            )}
            {target.url && (
              <a href={target.url} target="_blank" rel="noreferrer">
                {target.url}
              </a>
            )}
          </div>
        )}
        {!target.available && (
          <p className="text-error">Script not found in this checkout — nothing to run.</p>
        )}
      </div>
      {/* The bubble is a sibling anchored to the card (not the icon) so it
          spans the card's width and never spills past the section edge. */}
      <span
        className="admin-deploy-target__info tooltip-wrap"
        tabIndex={0}
        aria-label={`About ${target.label}`}
      >
        <Info size={18} aria-hidden />
      </span>
      <span className="tooltip-bubble admin-deploy-target__info-tip" role="tooltip">
        {target.description}
        <code>{target.command}</code>
      </span>
      <Button
        onClick={onRun}
        loading={pending}
        disabled={disabled}
        variant={isProduction ? "default" : "outline"}
      >
        {/* No inline margin: `.btn` already sets its own icon/label gap, and
            the two stacked left a visible hole between them. */}
        <Play size={14} aria-hidden />
        {busy && !pending ? "Busy" : isProduction ? "Deploy to live" : "Deploy"}
      </Button>
    </div>
  );
}

function ConfirmDeployDialog({
  target,
  pending,
  onCancel,
  onConfirm,
}: {
  target: DeployTargetRow;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !pending) onCancel();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Deploy to {target.url ?? "production"}?</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p>
            This uploads the current state of your working copy — including uncommitted changes —
            builds it on the swarm host and rolls the{" "}
            <strong>{target.stack ?? "production"}</strong> stack.
          </p>
          <ul className="delete-app-list with-bullets">
            <li>Postgres is dumped before anything is applied.</li>
            <li>Web and API roll one at a time; the old task only stops once the new one is healthy.</li>
            <li>An API that never reports healthy rolls back to the previous image automatically.</li>
            <li>Expect several minutes — the images are built from scratch on the host.</li>
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={pending}>
            Deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

  // Auto-scroll to the bottom as output streams in, unless the user has
  // scrolled away — same behaviour (and same tolerances) as the build page.
  const logRef = useRef<HTMLDivElement>(null);
  const stuckToBottomRef = useRef(true);
  // True for the brief window between our programmatic scrollTop write and the
  // resulting scroll event — keeps the user-scroll detector from mistakenly
  // disengaging auto-scroll on our own writes.
  const programmaticScrollRef = useRef(false);
  useEffect(() => {
    stuckToBottomRef.current = true;
  }, [jobId]);
  useEffect(() => {
    if (!stuckToBottomRef.current) return;
    // rAF so the scroll happens after layout has settled with the new content.
    const raf = requestAnimationFrame(() => {
      const el = logRef.current;
      if (!el) return;
      programmaticScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [raw]);
  const onLogScroll = () => {
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false;
      return;
    }
    const el = logRef.current;
    if (!el) return;
    // 24px tolerance covers scrollbar thumb height, partial-line wraps, and
    // small layout-shift jitter.
    stuckToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  // Copy-to-clipboard for the log; the tick flips back to the copy icon.
  const [logCopied, setLogCopied] = useState(false);
  const copyLog = () => {
    if (!raw) return;
    void navigator.clipboard.writeText(raw).then(() => {
      setLogCopied(true);
      setTimeout(() => setLogCopied(false), 1500);
    });
  };

  if (!job) {
    return (
      <div className="admin-deploy-log__placeholder">
        <Loading>Loading run…</Loading>
      </div>
    );
  }

  return (
    <>
      <div className="admin-deploy-log__header">
        <StateIcon state={job.state} />
        <div className="admin-deploy-log__meta">
          <span className="admin-deploy-log__title">{job.targetLabel}</span>
          <code className="admin-deploy-target__cmd">{job.command}</code>
        </div>
        <span className="text-help">
          {job.state === "running"
            ? wsConnected
              ? "streaming"
              : "polling"
            : `${job.state}${job.exitCode != null ? ` · exit ${job.exitCode}` : ""}`}
        </span>
        <div className="admin-deploy-log__tools">
          <button
            type="button"
            className="admin-deploy-log__copy tooltip-wrap"
            onClick={copyLog}
            disabled={!raw}
            aria-label={logCopied ? "Log copied" : "Copy log"}
          >
            {logCopied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            <span className="tooltip-bubble" role="tooltip">
              {logCopied ? "Copied" : "Copy log"}
            </span>
          </button>
          <span className="admin-deploy-log__count">
            {raw ? `${raw.length.toLocaleString()} chars` : ""}
          </span>
        </div>
        {job.state === "running" && (
          <Button variant="outline" className="btn-danger-outline" onClick={onCancel} loading={canceling}>
            <StopCircle size={14} aria-hidden />
            Cancel
          </Button>
        )}
      </div>

      {job.truncated && (
        <p className="admin-deploy-log__notice">
          Output was long — only the most recent lines are kept.
        </p>
      )}

      {/* app-scroll matches the build page's log scrollbar on the dark surface. */}
      <LogView
        ref={logRef}
        raw={raw}
        onScroll={onLogScroll}
        className="admin-deploy-log__body app-scroll"
        empty="Waiting for output…"
      />
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
