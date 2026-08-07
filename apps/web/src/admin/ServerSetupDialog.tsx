import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Loading,
} from "@mobileflow/ui";
import { CircleCheckBig, CircleHelp, Loader2, RefreshCw, ShieldAlert, X } from "lucide-react";
import { api, type HostSetupJob, type HostSetupStatus, type HostSetupStep } from "../api/client";
import { CircleXBig } from "../components/CircleXBig";
import { Collapse } from "../components/Collapse";

/**
 * "Server setup" — provisioning checklist for a Mac build host, stacked on top
 * of the Edit build host dialog. Local-development only (the API refuses
 * otherwise). Each step is detected over SSH; auto steps run scripts on the
 * Mac and stream their output below; manual steps show what to do by hand.
 */
export function ServerSetupDialog({
  hostId,
  hostName,
  onClose,
}: {
  hostId: string;
  hostName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [sudoPassword, setSudoPassword] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  const status = useQuery({
    queryKey: ["admin", "host-setup", hostId],
    queryFn: () => api.admin.hostSetup(hostId),
    // Detection SSHes into the Mac — refetch only on demand.
    staleTime: Infinity,
    retry: false,
  });

  // ---- running job state (polled) ----
  const [job, setJob] = useState<HostSetupJob | null>(null);
  const [jobLines, setJobLines] = useState<{ seq: number; text: string }[]>([]);
  const [activeStep, setActiveStep] = useState<HostSetupStep | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  useEffect(() => stopPolling, []);

  const beginPolling = (jobId: string) => {
    stopPolling();
    let lastSeq = 0;
    pollRef.current = setInterval(async () => {
      try {
        const j = await api.admin.hostSetupJob(hostId, jobId, lastSeq);
        if (j.lines.length > 0) {
          lastSeq = j.lines[j.lines.length - 1]!.seq;
          setJobLines((prev) => [...prev, ...j.lines]);
        }
        setJob(j);
        if (j.state !== "running") {
          stopPolling();
          // Re-detect so the checklist reflects what the step changed.
          void status.refetch();
        }
      } catch {
        stopPolling();
      }
    }, 700);
  };

  const run = useMutation({
    mutationFn: (input: { step: HostSetupStep; revert: boolean }) =>
      api.admin.runHostSetupStep(hostId, {
        stepId: input.step.id,
        revert: input.revert,
        ...((input.revert ? input.step.revertNeedsSudo : input.step.runNeedsSudo)
          ? { sudoPassword }
          : {}),
      }),
    onSuccess: (res, input) => {
      setActiveStep(input.step);
      setJob(null);
      setJobLines([]);
      beginPolling(res.jobId);
    },
  });

  const data = status.data;
  const steps = data?.steps ?? [];
  const readyCount = steps.filter((s) => s.status === "ok").length;
  const busy = run.isPending || job?.state === "running";
  const needsSudoSomewhere = steps.some((s) => s.canRun && s.runNeedsSudo);

  // Offer to point the host row at the tunnel address once BOTH ends work:
  // the Mac's tunnel, and the production host's route to it.
  const tunnelOk = steps.find((s) => s.id === "tunnel")?.status === "ok";
  const prodOk = steps.find((s) => s.id === "prodvpn")?.status === "ok";
  const vpnIp = data?.vpn.macIp ?? null;
  const suggestVpnIp = !!(data?.reachable && tunnelOk && prodOk && vpnIp && data.hostname !== vpnIp);
  const useVpnIp = useMutation({
    mutationFn: () => api.admin.patchHost(hostId, { hostname: vpnIp }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "hosts"] });
      void status.refetch();
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="host-setup-dialog"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="host-setup__heading">
            <DialogTitle>Server setup</DialogTitle>
            <DialogDescription>
              Provision <strong>{hostName}</strong> as a build host. Steps run over SSH from this
              (local) API and are recorded on the Mac in <code>~/.mobileflow/</code> so they can be
              reverted.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          {status.isLoading && (
            <div className="host-setup__loading">
              <Loading>Checking the Mac over SSH…</Loading>
            </div>
          )}
          {status.error && (
            <p className="text-error">{(status.error as Error).message}</p>
          )}

          {data && (
            <>
              <div className="host-setup__summary">
                <span className="host-setup__summary-count">
                  {readyCount} of {steps.length} steps ready
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => status.refetch()}
                  disabled={status.isFetching || busy}
                >
                  <RefreshCw size={14} className={status.isFetching ? "host-setup__spin" : undefined} aria-hidden />
                  Re-check
                </Button>
              </div>

              {!data.reachable && (
                <div className="host-setup__banner is-error">
                  <strong>Can't reach the Mac over SSH.</strong> {data.connectError}
                  <div className="host-setup__banner-hint">
                    On the Mac: System Settings → General → Sharing → enable <em>Remote Login</em>,
                    make sure this machine can reach <code>{data.hostname}</code>, and that the
                    stored SSH key is in <code>~/.ssh/authorized_keys</code>.
                  </div>
                </div>
              )}

              {data.reachable && !data.vpn.configured && (
                <div className="host-setup__banner">
                  VPN steps are locked: set <code>VPN_SERVER_ENDPOINT</code>,{" "}
                  <code>VPN_SERVER_PUBLIC_KEY</code> and <code>VPN_MAC_IP</code> in the API's{" "}
                  <code>.env</code> (optionally <code>VPN_VPS_*</code> for automatic peer
                  registration), then re-check.
                </div>
              )}

              {needsSudoSomewhere && (
                <div className="host-setup__sudo">
                  <Label htmlFor="setup-sudo" className="host-setup__sudo-label">
                    Mac admin password
                  </Label>
                  <Input
                    id="setup-sudo"
                    type="password"
                    value={sudoPassword}
                    onChange={(e) => setSudoPassword(e.target.value)}
                    placeholder="Required by steps marked “sudo”"
                    autoComplete="off"
                  />
                  <p className="host-setup__sudo-hint">
                    Sent once per step and piped straight to <code>sudo</code> on the Mac — never
                    stored, never logged.
                  </p>
                </div>
              )}

              <VpsAccessPanel
                hostId={hostId}
                vpn={data.vpn}
                onChanged={() => void status.refetch()}
              />

              <div className="host-setup__steps scrollbar">
                {steps.map((s) => (
                  <StepRow
                    key={s.id}
                    step={s}
                    busy={busy}
                    sudoReady={sudoPassword.length > 0}
                    onRun={(revert) => run.mutate({ step: s, revert })}
                  />
                ))}
              </div>

              {suggestVpnIp && (
                <div className="host-setup__banner is-success">
                  Tunnel verified end to end. This host still points at <code>{data.hostname}</code>{" "}
                  — switch it to the VPN address so production can reach it. (Local builds will
                  then also go through the VPN, so keep your VPN client connected when building
                  locally.)
                  <div className="host-setup__banner-action">
                    <Button size="sm" onClick={() => useVpnIp.mutate()} loading={useVpnIp.isPending}>
                      Set host address to {vpnIp}
                    </Button>
                  </div>
                </div>
              )}

              {run.error && <p className="text-error">{(run.error as Error).message}</p>}

              {(job || run.isPending) && (
                <div className="host-setup__log">
                  <div className="host-setup__log-title">
                    {job?.state === "running" || run.isPending ? (
                      <Loader2 size={14} className="host-setup__spin" aria-hidden />
                    ) : job?.state === "succeeded" ? (
                      <CircleCheckBig size={14} className="status-icon is-success" aria-hidden />
                    ) : (
                      <CircleXBig size={14} className="status-icon is-failed" aria-hidden />
                    )}
                    {activeStep ? `${job?.revert ? "Revert — " : ""}${activeStep.title}` : "Running…"}
                    {job && job.state !== "running" && (
                      <button
                        type="button"
                        className="host-setup__log-close"
                        onClick={() => {
                          setJob(null);
                          setJobLines([]);
                          setActiveStep(null);
                        }}
                        aria-label="Hide log"
                      >
                        <X size={14} aria-hidden />
                      </button>
                    )}
                  </div>
                  <LogPane lines={jobLines} />
                </div>
              )}

              {data.history.length > 0 && (
                <div className="host-setup__history">
                  <button
                    type="button"
                    className="host-setup__history-toggle"
                    onClick={() => setShowHistory((v) => !v)}
                  >
                    {showHistory ? "Hide" : "Show"} provisioning history ({data.history.length} entries)
                  </button>
                  <Collapse open={showHistory}>
                    <pre className="host-setup__history-log">{data.history.join("\n")}</pre>
                  </Collapse>
                </div>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// SSH access to the WireGuard server, fully in the UI: drop/pick the private
// key file, and if the server doesn't accept it yet, a one-time password
// bootstrap installs it into authorized_keys — no terminal involved.
function VpsAccessPanel({
  hostId,
  vpn,
  onChanged,
}: {
  hostId: string;
  vpn: HostSetupStatus["vpn"];
  onChanged: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [password, setPassword] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (key: string) => api.admin.uploadVpsKey(hostId, { key }),
    onSuccess: onChanged,
  });
  const authorize = useMutation({
    mutationFn: () => api.admin.authorizeVps(hostId, { password }),
    onSuccess: (r) => {
      if (r.ok) {
        setPassword("");
        onChanged();
      }
    },
  });

  const readFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") upload.mutate(reader.result);
    };
    reader.readAsText(f);
  };

  if (!vpn.vpsHost) return null;
  const ok = vpn.serverAccess === "ok";
  const keyAdded = upload.isSuccess;

  return (
    <div className="vps-access">
      <div className="vps-access__title">
        {ok ? (
          <CircleCheckBig size={16} className="status-icon is-success" aria-hidden />
        ) : (
          <CircleXBig size={16} className="status-icon is-failed" aria-hidden />
        )}
        <span>
          VPN server access — <code>{vpn.vpsUser}@{vpn.vpsHost}</code>
        </span>
        {ok ? (
          <span className="vps-access__detail">connected with the stored key</span>
        ) : vpn.serverAccess === "unreachable" ? (
          <span className="vps-access__detail">server unreachable</span>
        ) : keyAdded ? (
          <span className="vps-access__detail is-added">
            <CircleCheckBig size={13} aria-hidden />
            Key added — authorize it below
          </span>
        ) : vpn.serverAccess === "no-key" ? (
          <span className="vps-access__detail">no key stored yet</span>
        ) : null}
      </div>
      {!ok && vpn.serverAccess !== "unreachable" && (
        <>
          <input
            ref={fileRef}
            type="file"
            className="vps-access__file"
            onChange={(e) => {
              readFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className={`vps-access__drop${dragOver ? " is-over" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              readFile(e.dataTransfer.files?.[0]);
            }}
          >
            {upload.isPending
              ? "Storing key…"
              : "Drag & drop the server's private key file here, or click to browse"}
          </button>
          {vpn.serverAccess === "denied" && (
            <div className="vps-access__auth">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={`${vpn.vpsUser}@${vpn.vpsHost} password (used once)`}
                autoComplete="new-password"
                name="vps-root-password"
              />
              <Button
                size="sm"
                onClick={() => authorize.mutate()}
                disabled={!password}
                loading={authorize.isPending}
              >
                Authorize key on server
              </Button>
            </div>
          )}
          {vpn.serverAccess === "denied" && (
            <p className="vps-access__hint">
              The password logs in once to add the stored key to{" "}
              <code>authorized_keys</code>, then it's discarded — every later action uses the key.
            </p>
          )}
          {(upload.error || authorize.error || (authorize.data && !authorize.data.ok)) && (
            <p className="text-error">
              {(upload.error as Error)?.message ||
                (authorize.error as Error)?.message ||
                authorize.data?.error}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function StepRow({
  step,
  busy,
  sudoReady,
  onRun,
}: {
  step: HostSetupStep;
  busy: boolean;
  sudoReady: boolean;
  onRun: (revert: boolean) => void;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const runBlocked = step.runNeedsSudo && !sudoReady;
  const revertBlocked = step.revertNeedsSudo && !sudoReady;

  return (
    <div className={`host-setup-step is-${step.status}`}>
      <span className="host-setup-step__icon" aria-hidden>
        {step.status === "ok" && <CircleCheckBig size={18} className="status-icon is-success" />}
        {step.status === "missing" && <CircleXBig size={18} className="status-icon is-failed" />}
        {(step.status === "unknown" || step.status === "error") && (
          <CircleHelp size={18} className="status-icon is-muted" />
        )}
      </span>
      <div className="host-setup-step__main">
        <div className="host-setup-step__title-row">
          <span className="host-setup-step__title">{step.title}</span>
          {step.runNeedsSudo && (
            <span className="host-setup-step__tag" title="Needs the Mac admin password">
              <ShieldAlert size={11} aria-hidden /> sudo
            </span>
          )}
          {step.kind === "manual" && <span className="host-setup-step__tag">manual</span>}
        </div>
        {step.detail && <div className="host-setup-step__detail">{step.detail}</div>}
        <Collapse
          open={showInfo || (step.kind === "manual" && step.status !== "ok")}
          className="collapse--step-gap"
        >
          <p className="host-setup-step__description">{step.description}</p>
        </Collapse>
      </div>
      <div className="host-setup-step__actions">
        <button
          type="button"
          className="host-setup-step__info"
          onClick={() => setShowInfo((v) => !v)}
          aria-label={`About ${step.title}`}
        >
          <CircleHelp size={14} aria-hidden />
        </button>
        {step.canRun && step.status !== "ok" && (
          <Button
            size="sm"
            onClick={() => onRun(false)}
            disabled={busy || runBlocked}
            title={runBlocked ? "Enter the Mac admin password above first" : undefined}
          >
            Run
          </Button>
        )}
        {step.canRun && step.status === "ok" && (
          <Button size="sm" variant="outline" onClick={() => onRun(false)} disabled={busy || runBlocked}>
            Re-run
          </Button>
        )}
        {step.canRevert && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onRun(true)}
            disabled={busy || revertBlocked}
            title={revertBlocked ? "Enter the Mac admin password above first" : undefined}
          >
            Revert
          </Button>
        )}
      </div>
    </div>
  );
}

// Auto-scrolls to the newest line unless the user scrolled up to read.
function LogPane({ lines }: { lines: { seq: number; text: string }[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <pre ref={ref} className="host-setup__log-pane">
      {lines.map((l) => l.text).join("\n") || "…"}
    </pre>
  );
}
