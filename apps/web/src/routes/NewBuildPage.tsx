import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@mobileflow/ui";
import { ArrowLeft, Check, GitBranch, Plus, Search, Trash2 } from "lucide-react";
import { ApiError, api, type BuildTarget, type CommitRow } from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";

const TARGETS: { id: BuildTarget; label: string; icon: JSX.Element; iconBg: string }[] = [
  { id: "ios", label: "iOS", icon: <AppleIcon />, iconBg: "#0a0a0a" },
  { id: "android", label: "Android", icon: <AndroidIcon />, iconBg: "#34a853" },
  { id: "web", label: "Web", icon: <WebIcon />, iconBg: "#f7df1e" },
];

const STACKS: Record<BuildTarget, { id: string; label: string }[]> = {
  ios: [
    { id: "ios-15", label: "Xcode 15" },
    { id: "ios-16", label: "Xcode 16" },
  ],
  android: [{ id: "android-default", label: "Android (default)" }],
  web: [{ id: "web-default", label: "Web (Node 20)" }],
};

const BUILD_TYPES: Record<BuildTarget, { id: string; label: string }[] | null> = {
  ios: [
    { id: "simulator", label: "Simulator" },
    { id: "development", label: "Development" },
    { id: "adhoc", label: "Ad Hoc" },
    { id: "appstore", label: "App Store" },
  ],
  android: [
    { id: "debug", label: "Debug" },
    { id: "release", label: "Release" },
  ],
  web: null,
};

const PER_PAGE = 10;

export function NewBuildPage() {
  const { appId } = useParams();
  const [params] = useSearchParams();
  const commitId = params.get("commitId") ?? "";

  return commitId ? (
    <ConfigureBuild appId={appId!} sha={commitId} />
  ) : (
    <SelectCommit appId={appId!} />
  );
}

// ─── Step 1: Select commit ───────────────────────────────────────────────────

function SelectCommit({ appId }: { appId: string }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");

  const appQ = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.getApp(appId),
    enabled: !!appId,
  });

  const commitsQ = useQuery({
    queryKey: ["commits", appId, page],
    queryFn: () => api.listCommits(appId, { page, perPage: PER_PAGE }),
    enabled: !!appQ.data?.gitRepoFullName,
    placeholderData: keepPreviousData,
  });

  const branchName = appQ.data?.gitDefaultBranch ?? "main";
  const accountAvatarUrl = commitsQ.data?.accountAvatarUrl ?? null;
  const accountLogin = commitsQ.data?.accountLogin ?? null;

  const visible = useMemo(() => {
    const list = commitsQ.data?.items ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (c) =>
        c.sha.toLowerCase().includes(q) ||
        c.message.toLowerCase().includes(q) ||
        branchName.toLowerCase().includes(q),
    );
  }, [commitsQ.data?.items, filter, branchName]);

  return (
    <div className="new-build-page">
      <button type="button" className="new-build-back" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>
      <header className="new-build-header">
        <h1 className="new-build-title">Create a new build</h1>
        <Steps activeStep="select" />
      </header>

      <div className="new-build-section">
        <div className="select-commit-controls">
          <span className="new-build-label">Select a commit</span>
          <div className="commits-search">
            <Search size={14} className="commits-search__icon" aria-hidden />
            <input
              className="commits-search__input"
              placeholder="Search by hash, message, or branch"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>

        <div className="commits-list">
          {commitsQ.isLoading && <div className="commits-page__status">Loading commits…</div>}
          {commitsQ.error && (
            <div className="commits-page__status is-error">
              {(commitsQ.error as ApiError).message}
            </div>
          )}
          {!commitsQ.isLoading && !commitsQ.error && visible.length === 0 && (
            <div className="commits-page__status">
              {filter ? `No commits match "${filter}".` : "No commits to show."}
            </div>
          )}
          {visible.map((c) => (
            <SelectableCommitRow
              key={c.sha}
              commit={c}
              branchName={branchName}
              accountAvatarUrl={accountAvatarUrl}
              accountLogin={accountLogin}
              onPick={() => navigate(`/app/${appId}/build/builds/new?commitId=${c.sha}`)}
            />
          ))}
        </div>

        {commitsQ.data && (
          <div className="commits-footer">
            <span className="commits-footer__count">
              {commitsQ.data.totalCount != null
                ? `${commitsQ.data.totalCount.toLocaleString()} commit${commitsQ.data.totalCount === 1 ? "" : "s"}`
                : ""}
            </span>
            <div className="commits-footer__pager">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || commitsQ.isFetching}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={!commitsQ.data.hasNext || commitsQ.isFetching}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface SelectableCommitRowProps {
  commit: CommitRow;
  branchName: string;
  accountAvatarUrl: string | null;
  accountLogin: string | null;
  onPick: () => void;
}

function SelectableCommitRow({ commit, branchName, accountAvatarUrl, accountLogin, onPick }: SelectableCommitRowProps) {
  const title = commit.message.split("\n")[0] ?? "";
  const shortSha = commit.sha.slice(0, 6);
  const avatarSrc = accountAvatarUrl ?? commit.avatarUrl;
  const initial = (accountLogin || commit.authorName || "?").trim().charAt(0).toUpperCase();
  const fullDate = formatFullDate(commit.date);

  return (
    <button type="button" className="commit-row select-commit-row" onClick={onPick}>
      <div className="commit-row__avatar">
        {avatarSrc ? (
          <img src={avatarSrc} alt={accountLogin ?? ""} />
        ) : (
          <span className="commit-row__avatar-fallback">{initial}</span>
        )}
      </div>
      <div className="commit-row__main">
        <div className="commit-row__title">
          <span className="commit-row__message">{title}</span>
        </div>
        <div className="commit-row__meta">
          <span className="commit-row__author">{accountLogin ?? commit.authorName}</span>
          <span className="commit-row__sep">·</span>
          <span className="tooltip-wrap commit-row__date" tabIndex={0} aria-label={fullDate}>
            {relativeTime(commit.date)}
            <span className="tooltip-bubble" role="tooltip">{fullDate}</span>
          </span>
          <span className="commit-row__from">to</span>
          <span className="commit-row__branch">
            <GitBranch size={12} aria-hidden />
            <span>{branchName}</span>
          </span>
        </div>
      </div>
      <span className="select-commit-row__sha">{shortSha}</span>
    </button>
  );
}

// ─── Step 2: Configure build ─────────────────────────────────────────────────

function ConfigureBuild({ appId, sha }: { appId: string; sha: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [target, setTarget] = useState<BuildTarget>("ios");
  const [stackId, setStackId] = useState<string>(STACKS.ios[0]!.id);
  const [buildType, setBuildType] = useState<string>(BUILD_TYPES.ios![0]!.id);
  const [environmentId, setEnvironmentId] = useState<string>("");
  const [certificateId, setCertificateId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [envOpen, setEnvOpen] = useState(false);

  const appQ = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.getApp(appId),
    enabled: !!appId,
  });

  const commitQ = useQuery({
    queryKey: ["commit", appId, sha],
    queryFn: () => api.getCommit(appId, sha),
    enabled: !!sha,
  });

  const envsQ = useQuery({
    queryKey: ["envs", appId],
    queryFn: () => api.listEnvironments(appId),
    enabled: !!appId,
  });

  const orgId = appQ.data?.orgId ?? null;
  const certsQ = useQuery({
    queryKey: ["certs", orgId],
    queryFn: () => api.listCertificates(orgId!),
    enabled: !!orgId,
  });

  const branchName = appQ.data?.gitDefaultBranch ?? "main";

  const platformCerts = useMemo(() => {
    if (target === "web") return [];
    return (certsQ.data ?? []).filter((c) => c.platform === target);
  }, [certsQ.data, target]);

  // Keep certificateId valid when the target changes or certs load: default to
  // the first matching cert, or clear when none are available.
  useEffect(() => {
    if (target === "web") {
      if (certificateId) setCertificateId("");
      return;
    }
    if (platformCerts.length === 0) {
      if (certificateId) setCertificateId("");
      return;
    }
    if (!platformCerts.some((c) => c.id === certificateId)) {
      setCertificateId(platformCerts[0]!.id);
    }
  }, [target, platformCerts, certificateId]);

  const onTargetChange = (t: BuildTarget) => {
    setTarget(t);
    setStackId(STACKS[t][0]!.id);
    const types = BUILD_TYPES[t];
    setBuildType(types ? types[0]!.id : "");
  };

  const start = useMutation({
    mutationFn: () =>
      api.startBuild(appId, {
        commitSha: sha,
        commitMessage: commitQ.data?.message?.split("\n")[0] ?? undefined,
        branch: branchName,
        target,
        stackId,
        buildType: buildType || undefined,
        environmentId: environmentId || undefined,
        certificateId: certificateId || undefined,
      }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ["builds", appId] });
      navigate(`/app/${appId}/build/builds/${b.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to start build"),
  });

  return (
    <div className="new-build-page">
      <button type="button" className="new-build-back" onClick={() => navigate(-1)}>
        <ArrowLeft size={14} /> Back
      </button>
      <header className="new-build-header">
        <h1 className="new-build-title">Create a new build</h1>
        <Steps activeStep="configure" />
      </header>

      <CommitPanel
        appId={appId}
        sha={sha}
        commit={commitQ.data ?? null}
        loading={commitQ.isLoading}
        loadError={commitQ.error instanceof Error ? commitQ.error.message : null}
        branchName={branchName}
      />

      <div className="new-build-details">
        <div className="new-build-details__heading">Build details</div>

        <div className="new-build-section">
          <Label className="new-build-label">Target platform</Label>
          <div className="target-platforms">
            {TARGETS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`target-platform${target === t.id ? " is-selected" : ""}`}
                onClick={() => onTargetChange(t.id)}
              >
                <span className="target-platform__icon" style={{ background: t.iconBg }}>
                  {t.icon}
                </span>
                <span className="target-platform__label">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="new-build-section">
          <Label className="new-build-label" htmlFor="build-stack">Build stack</Label>
          <select
            id="build-stack"
            className="new-build-select"
            value={stackId}
            onChange={(e) => setStackId(e.target.value)}
          >
            {STACKS[target].map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </select>
        </div>

        {BUILD_TYPES[target] && (
          <div className="new-build-section">
            <Label className="new-build-label" htmlFor="build-type">Build type</Label>
            <select
              id="build-type"
              className="new-build-select"
              value={buildType}
              onChange={(e) => setBuildType(e.target.value)}
            >
              {BUILD_TYPES[target]!.map((bt) => (
                <option key={bt.id} value={bt.id}>{bt.label}</option>
              ))}
            </select>
          </div>
        )}

        {target !== "web" && (
          <div className="new-build-section">
            <Label className="new-build-label" htmlFor="signing-cert">Signing certificate</Label>
            {platformCerts.length > 0 ? (
              <select
                id="signing-cert"
                className="new-build-select"
                value={certificateId}
                onChange={(e) => setCertificateId(e.target.value)}
              >
                {platformCerts.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            ) : (
              <p className="new-build-help">
                No {target === "ios" ? "iOS" : "Android"} certificate on file.{" "}
                <Link to={`/app/${appId}/build/certificates`} className="new-build-link">
                  Add one
                </Link>{" "}
                to sign this build.
              </p>
            )}
          </div>
        )}

        <div className="new-build-section">
          <Label className="new-build-label" htmlFor="env">
            Environment <span className="new-build-label__hint">(optional)</span>
          </Label>
          <p className="new-build-help">The group of environment variables exposed to your build.</p>
          <select
            id="env"
            className="new-build-select"
            value={environmentId}
            onChange={(e) => setEnvironmentId(e.target.value)}
          >
            <option value="">None</option>
            {envsQ.data?.map((env) => (
              <option key={env.id} value={env.id}>{env.name}</option>
            ))}
          </select>
          <button
            type="button"
            className="new-build-link-button"
            onClick={() => setEnvOpen(true)}
          >
            <Plus size={12} /> Add environment
          </button>
        </div>

        {error && <p className="new-build-error">{error}</p>}

        <div className="new-build-actions">
          <Button variant="outline" onClick={() => navigate(-1)}>Cancel</Button>
          <Button onClick={() => start.mutate()} loading={start.isPending} disabled={!commitQ.data}>
            Build
          </Button>
        </div>
      </div>

      <NewEnvironmentDialog
        appId={appId}
        open={envOpen}
        onOpenChange={setEnvOpen}
        onCreated={(envId) => {
          setEnvironmentId(envId);
          setEnvOpen(false);
        }}
      />
    </div>
  );
}

interface CommitPanelProps {
  appId: string;
  sha: string;
  commit: (CommitRow & { accountLogin: string | null; accountAvatarUrl: string | null }) | null;
  loading: boolean;
  loadError: string | null;
  branchName: string;
}

function CommitPanel({ appId, sha, commit, loading, loadError, branchName }: CommitPanelProps) {
  const navigate = useNavigate();
  const shortSha = sha.slice(0, 6);

  return (
    <div className="commit-panel">
      <div className="commit-panel__avatar">
        {commit?.accountAvatarUrl || commit?.avatarUrl ? (
          <img src={commit.accountAvatarUrl ?? commit.avatarUrl ?? ""} alt={commit?.accountLogin ?? ""} />
        ) : (
          <span className="commit-row__avatar-fallback">
            {(commit?.accountLogin || commit?.authorName || "?").trim().charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className="commit-panel__main">
        {loading ? (
          <span className="commit-panel__loading">Loading commit…</span>
        ) : loadError ? (
          <span className="commit-panel__error">{loadError}</span>
        ) : commit ? (
          <>
            <div className="commit-panel__title">{commit.message.split("\n")[0]}</div>
            <div className="commit-panel__meta">
              <span>{commit.accountLogin ?? commit.authorName}</span>
              <span className="commit-row__sep">·</span>
              <span className="tooltip-wrap" tabIndex={0}>
                {relativeTime(commit.date)}
                <span className="tooltip-bubble" role="tooltip">{formatFullDate(commit.date)}</span>
              </span>
              <span className="commit-row__from">to</span>
              <span className="commit-row__branch">
                <GitBranch size={12} aria-hidden />
                <span>{branchName}</span>
              </span>
            </div>
          </>
        ) : null}
      </div>
      <div className="commit-panel__sha">{shortSha}</div>
      <button
        type="button"
        className="commit-panel__change"
        onClick={() => navigate(`/app/${appId}/build/builds/new`)}
      >
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
        <span> Select commit</span>
      </span>
      <span className={`new-build-step${activeStep === "configure" ? " is-active" : ""}`}>
        2. Configure build
      </span>
    </div>
  );
}

// ─── Add Environment dialog ──────────────────────────────────────────────────

interface NewEnvKV {
  key: string;
  value: string;
}

interface NewEnvironmentDialogProps {
  appId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (envId: string) => void;
}

function NewEnvironmentDialog({ appId, open, onOpenChange, onCreated }: NewEnvironmentDialogProps) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [secrets, setSecrets] = useState<NewEnvKV[]>([{ key: "", value: "" }]);
  const [vars, setVars] = useState<NewEnvKV[]>([{ key: "", value: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNameError, setShowNameError] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setSecrets([{ key: "", value: "" }]);
      setVars([{ key: "", value: "" }]);
      setError(null);
      setShowNameError(false);
    }
  }, [open]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setShowNameError(true);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const env = await api.createEnvironment(appId, trimmed);
      const allKv = [
        ...secrets.filter((s) => s.key.trim()).map((s) => ({ ...s, isSecret: true })),
        ...vars.filter((v) => v.key.trim()).map((v) => ({ ...v, isSecret: false })),
      ];
      for (const kv of allKv) {
        await api.createEnvVar(env.id, {
          key: kv.key.trim().toUpperCase(),
          value: kv.value,
          isSecret: kv.isSecret,
        });
      }
      qc.invalidateQueries({ queryKey: ["envs", appId] });
      onCreated(env.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create environment");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="new-env-dialog">
        <DialogHeader>
          <DialogTitle>New Environment</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="new-env-field">
            <Label htmlFor="new-env-name">Name</Label>
            <Input
              id="new-env-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (e.target.value.trim()) setShowNameError(false);
              }}
              autoFocus
            />
            {showNameError && <p className="new-env-error">Name is required</p>}
          </div>

          <KvSection
            title="Secrets"
            description="Encrypted values available only to your build at runtime."
            rows={secrets}
            onChange={setSecrets}
          />
          <KvSection
            title="Variables"
            description="Values available to your builds at runtime. Use secrets (above) for sensitive data."
            rows={vars}
            onChange={setVars}
          />

          {error && <p className="new-env-error">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={create} loading={submitting}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface KvSectionProps {
  title: string;
  description: string;
  rows: NewEnvKV[];
  onChange: (rows: NewEnvKV[]) => void;
}

function KvSection({ title, description, rows, onChange }: KvSectionProps) {
  const update = (i: number, patch: Partial<NewEnvKV>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) =>
    onChange(rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [{ key: "", value: "" }]);
  const add = () => onChange([...rows, { key: "", value: "" }]);

  return (
    <div className="new-env-section">
      <div className="new-env-section__title">{title}</div>
      <p className="new-env-section__desc">{description}</p>
      <div className="new-env-kv">
        <div className="new-env-kv__head">
          <span>KEY</span>
          <span>VALUE</span>
          <span></span>
        </div>
        {rows.map((row, i) => (
          <div key={i} className="new-env-kv__row">
            <Input
              placeholder="Key"
              value={row.key}
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <Input
              placeholder="Value"
              value={row.value}
              onChange={(e) => update(i, { value: e.target.value })}
            />
            <button
              type="button"
              className="new-env-kv__remove"
              aria-label="Remove row"
              onClick={() => remove(i)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="new-build-link-button" onClick={add}>
          <Plus size={12} /> Add another
        </button>
      </div>
    </div>
  );
}

// ─── Inline platform icons (kept lightweight) ────────────────────────────────

function AppleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M19.665 16.811a10.316 10.316 0 0 1-1.021 1.837c-.537.767-.978 1.297-1.316 1.592-.525.482-1.089.73-1.692.744-.432 0-.954-.123-1.562-.373-.61-.249-1.17-.371-1.683-.371-.537 0-1.113.122-1.73.371-.616.25-1.114.381-1.495.393-.577.025-1.154-.229-1.729-.764-.367-.318-.83-.866-1.388-1.645-.598-.83-1.087-1.79-1.467-2.876-.413-1.17-.62-2.305-.62-3.402 0-1.257.272-2.34.815-3.249.428-.728 1-1.301 1.715-1.72.713-.42 1.485-.633 2.314-.647.46 0 1.063.142 1.81.422.745.28 1.225.422 1.435.422.158 0 .69-.165 1.594-.493.857-.305 1.58-.43 2.17-.382 1.605.13 2.81.764 3.612 1.905-1.434.873-2.144 2.094-2.13 3.66.013 1.222.451 2.238 1.314 3.046.39.371.825.658 1.31.864-.105.305-.215.598-.331.879zm-3.873-15.43c0 .938-.342 1.815-1.027 2.628-.825.964-1.823 1.522-2.906 1.434a2.93 2.93 0 0 1-.022-.354c0-.9.392-1.864 1.087-2.654.347-.4.787-.733 1.32-1 .533-.262 1.037-.408 1.512-.434.014.13.036.26.036.38z" />
    </svg>
  );
}

function AndroidIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.523 15.341a1.04 1.04 0 1 1 0-2.082 1.04 1.04 0 0 1 0 2.082m-11.046 0a1.04 1.04 0 1 1 0-2.082 1.04 1.04 0 0 1 0 2.082m11.42-6.02 2.078-3.6a.43.43 0 1 0-.745-.43l-2.103 3.643a13.05 13.05 0 0 0-5.127-1.04c-1.842 0-3.59.378-5.127 1.04L4.77 5.291a.43.43 0 1 0-.745.43l2.078 3.6C2.554 11.218 0 14.696 0 18.708h24c0-4.012-2.554-7.49-6.103-9.387" />
    </svg>
  );
}

function WebIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <text x="12" y="17" textAnchor="middle" fontSize="11" fontFamily="Arial, sans-serif" fontWeight="700" fill="#0a0a0a">JS</text>
    </svg>
  );
}
