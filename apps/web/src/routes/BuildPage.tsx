import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Button, Card, CardContent, CardHeader, CardTitle, cn } from "@mobileflow/ui";
import { ApiError, api, type BuildDetail, type BuildStepStatus } from "../api/client";

const STEP_DOT: Record<BuildStepStatus, string> = {
  pending: "bg-muted",
  running: "bg-primary animate-pulse",
  success: "bg-emerald-500",
  failed: "bg-destructive",
  skipped: "bg-muted",
};

interface SnapshotEvent {
  type: "snapshot";
  build: BuildDetail;
  steps: BuildDetail["steps"];
  log: string;
}
interface LogEvent { type: "log"; line: string; offset: number }
interface StepEvent { type: "step"; name: string; status: BuildStepStatus; exitCode?: number }
interface StatusEvent { type: "status"; status: BuildDetail["status"]; errorMessage?: string | null }
interface ArtifactsEvent { type: "artifacts"; artifacts: { kind: string; url: string }[] }
type StreamEvent = SnapshotEvent | LogEvent | StepEvent | StatusEvent | ArtifactsEvent | { type: "error"; message: string };

export function BuildPage() {
  const { buildId } = useParams();
  const qc = useQueryClient();
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
          s ? { ...s, status: evt.status, errorMessage: evt.errorMessage ?? s.errorMessage } : s,
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
      // Already finished (race with the worker) — treat as success and let
      // the snapshot/poll catch up to the new status.
      if (!(err instanceof ApiError) || err.message !== "Build is already finished") throw err;
    } finally {
      void qc.invalidateQueries({ queryKey: ["build", buildId] });
    }
  };

  // Prefer live WS snapshot while the socket is open; otherwise trust polling,
  // which keeps progressing after the WS drops.
  const b = wsConnected ? (snapshot ?? pollQ.data) : (pollQ.data ?? snapshot);
  if (!b && pollQ.isLoading && !wsConnected) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (pollQ.error && !b) return <p className="text-sm text-destructive">{(pollQ.error as ApiError).message}</p>;
  if (!b) return <p className="text-sm text-muted-foreground">Connecting…</p>;
  const live = b.status === "queued" || b.status === "running";

  return (
    <div className="max-w-5xl grid gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Build {b.id.slice(0, 8)}</h1>
          <p className="text-sm text-muted-foreground">
            {b.target} · {b.stackId} · commit <code>{b.commitSha.slice(0, 7)}</code>
            <span className="ml-2 text-xs uppercase rounded-full px-2 py-0.5 bg-muted">
              {wsConnected ? "live" : "polling"}
            </span>
          </p>
        </div>
        {live && (
          <Button variant="destructive" onClick={cancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-2">
            {b.steps.map((s) => (
              <li key={s.id ?? s.name} className="flex items-center gap-3 text-sm">
                <span className={cn("h-2.5 w-2.5 rounded-full", STEP_DOT[s.status])} />
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">{s.status}</span>
                {s.exitCode != null && <span className="text-muted-foreground">(exit {s.exitCode})</span>}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Logs</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[420px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap">
            {logBuf || "(no output yet)"}
          </pre>
        </CardContent>
      </Card>

      {b.artifacts && b.artifacts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Artifacts</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 text-sm">
              {b.artifacts.map((a) => (
                <li key={a.url} className="flex items-center justify-between rounded-md border p-2">
                  <span className="font-mono text-xs">{a.kind}</span>
                  <a className="text-primary underline-offset-4 hover:underline" href={a.url}>
                    Download
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {b.errorMessage && <p className="text-sm text-destructive">Error: {b.errorMessage}</p>}
    </div>
  );
}
