import { useNavigate, useParams } from "react-router-dom";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@mobileflow/ui";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Lock, Search, X } from "lucide-react";
import type { Runtime } from "@mobileflow/shared";
import { ApiError, api, type BranchRow, type GitConnectionRow, type GitProvider, type RepoRow } from "../api/client";
import { RUNTIME_OPTIONS } from "../runtimes";

type HostDef = {
  id: GitProvider;
  label: string;
  bg: string;
  icon: JSX.Element;
};

const HOSTS: HostDef[] = [
  { id: "github", label: "GitHub", bg: "#0a0a0a", icon: <GithubIcon /> },
  { id: "bitbucket", label: "Bitbucket Cloud", bg: "#2563eb", icon: <BitbucketIcon /> },
  { id: "gitlab", label: "GitLab", bg: "#fc6d26", icon: <GitlabIcon /> },
];

type Step = "setup" | "repo" | "branch";

// Stash key for the in-progress form. Connecting a Git host does a full-page
// redirect to OAuth, so React state would be lost on return without this.
// Scoped to the org so two tabs on different orgs don't clobber each other.
function draftKey(orgId: string | undefined): string | null {
  return orgId ? `mf:import-app-draft:${orgId}` : null;
}

interface ImportDraft {
  name?: string;
  runtime?: Runtime;
}

function readDraft(orgId: string | undefined): ImportDraft {
  const key = draftKey(orgId);
  if (!key) return {};
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ImportDraft) : {};
  } catch {
    return {};
  }
}

export function ImportAppPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { orgId } = useParams();
  // Lazy initializers read sessionStorage once on mount. After an OAuth
  // round-trip, name/runtime are restored from whatever the user typed before
  // hitting Connect; otherwise we use the normal defaults.
  const [name, setName] = useState<string>(() => readDraft(orgId).name ?? "");
  const [runtime, setRuntime] = useState<Runtime>(() => readDraft(orgId).runtime ?? "capacitor");
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("setup");
  const [host, setHost] = useState<GitProvider | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedRepo, setSelectedRepo] = useState<RepoRow | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState("");
  const [branchPage, setBranchPage] = useState(1);

  const REPOS_PER_PAGE = 10;
  const BRANCHES_PER_PAGE = 10;

  const connsQ = useQuery({
    queryKey: ["git-connections", orgId],
    queryFn: () => api.listGitConnections(orgId!),
    enabled: !!orgId,
  });

  const conn = connsQ.data?.find((c) => c.provider === host) ?? null;
  const hostDef = HOSTS.find((h) => h.id === host) ?? null;

  const reposQ = useQuery({
    queryKey: ["repos", conn?.id],
    queryFn: () => api.listRepos(conn!.id),
    enabled: step === "repo" && !!conn,
  });

  const filteredRepos = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = reposQ.data ?? [];
    return q ? list.filter((r) => r.fullName.toLowerCase().includes(q)) : list;
  }, [reposQ.data, filter]);

  const totalPages = Math.max(1, Math.ceil(filteredRepos.length / REPOS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pagedRepos = filteredRepos.slice((safePage - 1) * REPOS_PER_PAGE, safePage * REPOS_PER_PAGE);

  const branchesQ = useQuery({
    queryKey: ["branches", conn?.id, selectedRepo?.fullName],
    queryFn: () => api.listBranches(conn!.id, selectedRepo!.fullName),
    enabled: step === "branch" && !!conn && !!selectedRepo,
  });

  const filteredBranches = useMemo(() => {
    const q = branchFilter.trim().toLowerCase();
    const list = branchesQ.data ?? [];
    return q ? list.filter((b) => b.name.toLowerCase().includes(q)) : list;
  }, [branchesQ.data, branchFilter]);

  const branchTotalPages = Math.max(1, Math.ceil(filteredBranches.length / BRANCHES_PER_PAGE));
  const safeBranchPage = Math.min(branchPage, branchTotalPages);
  const pagedBranches = filteredBranches.slice(
    (safeBranchPage - 1) * BRANCHES_PER_PAGE,
    safeBranchPage * BRANCHES_PER_PAGE,
  );

  const createApp = useMutation({
    mutationFn: (opts: { gitConnectionId?: string; gitRepoFullName?: string; gitDefaultBranch?: string }) =>
      api.createApp(orgId!, {
        name: name.trim(),
        runtime,
        gitConnectionId: opts.gitConnectionId ?? null,
        gitRepoFullName: opts.gitRepoFullName ?? null,
        gitDefaultBranch: opts.gitDefaultBranch ?? null,
      }),
    onSuccess: (created) => {
      const key = draftKey(orgId);
      if (key) {
        try { sessionStorage.removeItem(key); } catch { /* ignore */ }
      }
      qc.invalidateQueries({ queryKey: ["apps", orgId] });
      navigate(`/app/${created.id}/commits`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not create app"),
  });

  const setupValid = name.trim().length > 0;
  const submitting = createApp.isPending;

  function handleHostContinue(provider: GitProvider) {
    if (!setupValid) {
      setError("Enter an app name first");
      return;
    }
    setError(null);
    setHost(provider);
    setFilter("");
    setPage(1);
    setStep("repo");
  }

  function handleFilter(v: string) {
    setFilter(v);
    setPage(1);
  }

  function handleHostConnect(provider: GitProvider) {
    if (!orgId) return;
    // Persist the in-progress form before the full-page OAuth redirect so it
    // can be restored when the browser lands back on this URL.
    const key = draftKey(orgId);
    if (key) {
      try {
        sessionStorage.setItem(key, JSON.stringify({ name, runtime }));
      } catch {
        /* sessionStorage may be unavailable (Safari private mode); just lose the draft. */
      }
    }
    const returnTo = `/org/${orgId}/apps/import`;
    const qs = new URLSearchParams({ orgId, returnTo }).toString();
    window.location.href = `/api/orgs/git-connections/${provider}/start?${qs}`;
  }

  function handleConnectLater() {
    if (!setupValid || submitting) return;
    setError(null);
    createApp.mutate({});
  }

  function handlePickRepo(repo: RepoRow) {
    if (!conn || submitting) return;
    setError(null);
    setSelectedRepo(repo);
    setBranch(repo.defaultBranch);
    setBranchFilter("");
    setBranchPage(1);
    setStep("branch");
  }

  function handlePickBranch(name: string) {
    if (!conn || !selectedRepo || submitting) return;
    setError(null);
    setBranch(name);
    createApp.mutate({
      gitConnectionId: conn.id,
      gitRepoFullName: selectedRepo.fullName,
      gitDefaultBranch: name,
    });
  }

  return (
    <div className="import-page">
      <button
        type="button"
        className="import-page__close"
        aria-label="Close"
        onClick={() => navigate(`/org/${orgId}/apps`)}
      >
        <X size={16} />
      </button>

      <header className="import-page__header">
        <h1 className="page-title">Import app</h1>
        <div className="import-page__steps">
          <button
            type="button"
            className={`import-page__step${step === "setup" ? " is-active" : " is-done"}`}
            onClick={() => setStep("setup")}
            disabled={step === "setup"}
          >
            {step === "setup" ? (
              <span>1.</span>
            ) : (
              <Check size={14} className="import-page__step-check" aria-hidden />
            )}
            <span> Set up app</span>
          </button>
          <button
            type="button"
            className={`import-page__step${
              step === "repo" ? " is-active" : step === "branch" ? " is-done" : ""
            }`}
            onClick={() => {
              if (step === "branch") setStep("repo");
            }}
            disabled={step !== "branch"}
          >
            {step === "branch" ? (
              <Check size={14} className="import-page__step-check" aria-hidden />
            ) : (
              <span>2.</span>
            )}
            <span> Select repo</span>
          </button>
          <span className={`import-page__step${step === "branch" ? " is-active" : ""}`}>
            3. Select branch
          </span>
        </div>
      </header>

      {step === "setup" && (
        <SetupStep
          name={name}
          onName={setName}
          runtime={runtime}
          onRuntime={setRuntime}
          conns={connsQ.data ?? []}
          onContinue={handleHostContinue}
          onConnect={handleHostConnect}
          onConnectLater={handleConnectLater}
          submitting={submitting}
        />
      )}

      {step === "repo" && hostDef && conn && (
        <RepoStep
          hostDef={hostDef}
          conn={conn}
          repos={pagedRepos}
          totalRepos={reposQ.data?.length ?? 0}
          filteredCount={filteredRepos.length}
          filter={filter}
          onFilter={handleFilter}
          isLoading={reposQ.isLoading}
          loadError={reposQ.error instanceof Error ? reposQ.error.message : null}
          onBack={() => setStep("setup")}
          onPick={handlePickRepo}
          submitting={submitting}
          page={safePage}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      )}

      {step === "branch" && hostDef && conn && selectedRepo && (
        <BranchStep
          hostDef={hostDef}
          repo={selectedRepo}
          branches={pagedBranches}
          totalBranches={branchesQ.data?.length ?? 0}
          filteredCount={filteredBranches.length}
          filter={branchFilter}
          onFilter={(v) => {
            setBranchFilter(v);
            setBranchPage(1);
          }}
          isLoading={branchesQ.isLoading}
          loadError={branchesQ.error instanceof Error ? branchesQ.error.message : null}
          selected={branch}
          onBack={() => setStep("repo")}
          onPick={handlePickBranch}
          submitting={submitting}
          page={safeBranchPage}
          totalPages={branchTotalPages}
          onPageChange={setBranchPage}
        />
      )}

      {error && <p className="import-error">{error}</p>}
    </div>
  );
}

interface SetupStepProps {
  name: string;
  onName: (v: string) => void;
  runtime: Runtime;
  onRuntime: (r: Runtime) => void;
  conns: GitConnectionRow[];
  onContinue: (h: GitProvider) => void;
  onConnect: (h: GitProvider) => void;
  onConnectLater: () => void;
  submitting: boolean;
}

function SetupStep(props: SetupStepProps) {
  const { name, onName, runtime, onRuntime, conns, onContinue, onConnect, onConnectLater, submitting } = props;
  const disabled = !name.trim() || submitting;

  return (
    <>
      <div className="import-section">
        <label className="import-section__label" htmlFor="import-app-name">
          App name
        </label>
        <Input
          id="import-app-name"
          className="import-section__input"
          value={name}
          onChange={(e) => onName(e.target.value)}
          autoFocus
        />
      </div>

      <div className="import-section">
        <span className="import-section__label">Select your native runtime</span>
        <div className="import-runtimes">
          {RUNTIME_OPTIONS.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`import-runtime${runtime === r.id ? " is-selected" : ""}`}
              onClick={() => onRuntime(r.id)}
            >
              <span className="import-runtime__icon" style={{ background: r.bg }}>
                {r.icon}
              </span>
              <span className="import-runtime__name">{r.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="import-section">
        <span className="import-section__label">Select your app's git host</span>
        <div className="import-hosts">
          {HOSTS.map((h) => {
            const conn = conns.find((c) => c.provider === h.id);
            const connected = !!conn;
            return (
              <div key={h.id} className="import-host">
                <span className="import-host__icon" style={{ background: h.bg }}>
                  {h.icon}
                </span>
                <div className="import-host__meta">
                  <span className="import-host__name">{h.label}</span>
                  {connected ? (
                    <span className="import-host__status is-connected">
                      <Check size={12} /> Connected
                    </span>
                  ) : (
                    <span className="import-host__status">Not connected</span>
                  )}
                </div>
                <div className="import-host__action">
                  {connected ? (
                    <div className="import-host__continue">
                      <span
                        className="import-runtime__icon"
                        style={{ background: h.bg, width: 28, height: 28 }}
                      >
                        {h.icon}
                      </span>
                      <div className="import-host__continue-meta">
                        <span className="import-host__continue-name">{conn!.accountLogin}</span>
                        <span className="import-host__continue-repo">{h.label}</span>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => onContinue(h.id)}
                        disabled={disabled}
                      >
                        Continue
                        <ArrowRight size={14} style={{ marginLeft: 4 }} />
                      </Button>
                    </div>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => onConnect(h.id)}>
                      Connect
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="import-page__later">
        <Button
          variant="outline"
          size="sm"
          onClick={onConnectLater}
          disabled={disabled}
          loading={submitting}
        >
          Connect git host later
        </Button>
      </div>
    </>
  );
}

interface RepoStepProps {
  hostDef: HostDef;
  conn: GitConnectionRow;
  repos: RepoRow[];
  totalRepos: number;
  filteredCount: number;
  filter: string;
  onFilter: (v: string) => void;
  isLoading: boolean;
  loadError: string | null;
  onBack: () => void;
  onPick: (repo: RepoRow) => void;
  submitting: boolean;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}

function RepoStep(props: RepoStepProps) {
  const {
    hostDef,
    conn,
    repos,
    totalRepos,
    filteredCount,
    filter,
    onFilter,
    isLoading,
    loadError,
    onBack,
    onPick,
    submitting,
    page,
    totalPages,
    onPageChange,
  } = props;
  return (
    <div className="import-section">
      <div className="import-repo-header">
        <button type="button" className="import-repo-back" onClick={onBack} aria-label="Back to set up app">
          <ArrowLeft size={14} />
        </button>
        <span className="import-section__label" style={{ marginBottom: 0 }}>
          Select a repository
        </span>
      </div>

      <div className="import-repo-controls">
        <div className="import-repo-account">
          <span className="import-repo-account__icon" style={{ background: hostDef.bg }}>
            {hostDef.icon}
          </span>
          <span className="import-repo-account__name">{conn.accountLogin}</span>
          <ChevronDown size={14} className="import-repo-account__chev" aria-hidden />
        </div>
        <div className="import-repo-search">
          <Search size={14} className="import-repo-search__icon" aria-hidden />
          <input
            className="import-repo-search__input"
            placeholder="Find a repository..."
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
          />
          {filter && (
            <button
              type="button"
              className="import-repo-search__clear"
              aria-label="Clear search"
              onClick={() => onFilter("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="import-repos">
        {isLoading && <div className="import-repos__empty">Loading repositories…</div>}
        {!isLoading && loadError && (
          <div className="import-repos__empty is-error">{loadError}</div>
        )}
        {!isLoading && !loadError && totalRepos === 0 && (
          <div className="import-repos__empty">No repositories found for this account.</div>
        )}
        {!isLoading && !loadError && totalRepos > 0 && filteredCount === 0 && (
          <div className="import-repos__empty">No repositories match "{filter}".</div>
        )}
        {repos.map((r) => (
          <button
            key={r.id}
            type="button"
            className="import-repo"
            onClick={() => onPick(r)}
            disabled={submitting}
          >
            <span className="import-repo__icon">{hostDef.icon}</span>
            <span className="import-repo__name">{r.fullName}</span>
            {r.private && (
              <span className="import-repo__lock" aria-label="Private">
                <Lock size={12} />
              </span>
            )}
          </button>
        ))}
      </div>

      {!isLoading && !loadError && filteredCount > 0 && (
        <div className="import-repos__pager">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

interface BranchStepProps {
  hostDef: HostDef;
  repo: RepoRow;
  branches: BranchRow[];
  totalBranches: number;
  filteredCount: number;
  filter: string;
  onFilter: (v: string) => void;
  isLoading: boolean;
  loadError: string | null;
  selected: string | null;
  onBack: () => void;
  onPick: (name: string) => void;
  submitting: boolean;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}

function BranchStep(props: BranchStepProps) {
  const {
    hostDef,
    repo,
    branches,
    totalBranches,
    filteredCount,
    filter,
    onFilter,
    isLoading,
    loadError,
    selected,
    onBack,
    onPick,
    submitting,
    page,
    totalPages,
    onPageChange,
  } = props;
  return (
    <div className="import-section">
      <div className="import-repo-header">
        <button type="button" className="import-repo-back" onClick={onBack} aria-label="Back to select repo">
          <ArrowLeft size={14} />
        </button>
        <span className="import-section__label" style={{ marginBottom: 0 }}>
          Select a branch
        </span>
      </div>

      <div className="import-repo-controls">
        <div className="import-repo-account">
          <span className="import-repo-account__icon" style={{ background: hostDef.bg }}>
            {hostDef.icon}
          </span>
          <span className="import-repo-account__name">{repo.fullName}</span>
        </div>
        <div className="import-repo-search">
          <Search size={14} className="import-repo-search__icon" aria-hidden />
          <input
            className="import-repo-search__input"
            placeholder="Find a branch..."
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
          />
          {filter && (
            <button
              type="button"
              className="import-repo-search__clear"
              aria-label="Clear search"
              onClick={() => onFilter("")}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="import-repos">
        {isLoading && <div className="import-repos__empty">Loading branches…</div>}
        {!isLoading && loadError && (
          <div className="import-repos__empty is-error">{loadError}</div>
        )}
        {!isLoading && !loadError && totalBranches === 0 && (
          <div className="import-repos__empty">No branches found for this repository.</div>
        )}
        {!isLoading && !loadError && totalBranches > 0 && filteredCount === 0 && (
          <div className="import-repos__empty">No branches match "{filter}".</div>
        )}
        {branches.map((b) => (
          <button
            key={b.name}
            type="button"
            className={`import-repo${selected === b.name ? " is-selected" : ""}`}
            onClick={() => onPick(b.name)}
            disabled={submitting}
          >
            <span className="import-repo__name">{b.name}</span>
            {b.isDefault && <span className="import-repo__lock">default</span>}
          </button>
        ))}
      </div>

      {!isLoading && !loadError && filteredCount > 0 && (
        <div className="import-repos__pager">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 512 512" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M256 32C132.3 32 32 134.9 32 261.7c0 101.5 64.2 187.5 153.2 217.9a17.56 17.56 0 003.8.4c8.3 0 11.5-6.1 11.5-11.4 0-5.5-.2-19.9-.3-39.1a102.4 102.4 0 01-22.6 2.7c-43.1 0-52.9-33.5-52.9-33.5-10.2-26.5-24.9-33.6-24.9-33.6-19.5-13.7-.1-14.1 1.4-14.1h.1c22.5 2 34.3 23.8 34.3 23.8 11.2 19.6 26.2 25.1 39.6 25.1a63 63 0 0025.6-6c2-14.8 7.8-24.9 14.2-30.7-49.7-5.8-102-25.5-102-113.5 0-25.1 8.7-45.6 23-61.6-2.3-5.8-10-29.2 2.2-60.8a18.64 18.64 0 015-.5c8.1 0 26.4 3.1 56.6 24.1a208.21 208.21 0 01112.2 0c30.2-21 48.5-24.1 56.6-24.1a18.64 18.64 0 015 .5c12.2 31.6 4.5 55 2.2 60.8 14.3 16.1 23 36.6 23 61.6 0 88.2-52.4 107.6-102.3 113.3 8 7.1 15.2 21.1 15.2 42.5 0 30.7-.3 55.5-.3 63 0 5.4 3.1 11.5 11.4 11.5a19.35 19.35 0 004-.4C415.9 449.2 480 363.1 480 261.7 480 134.9 379.7 32 256 32z" />
    </svg>
  );
}

function BitbucketIcon() {
  return (
    <svg viewBox="0 0 512 512" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M483.13 32.23a19.65 19.65 0 00-2.54-.23h-449C23 31.88 16.12 38.88 16 47.75a11.44 11.44 0 00.23 2.8l65.3 411.25a22.52 22.52 0 007 12.95A20 20 0 00102 480h313.18a15.45 15.45 0 0015.34-13.42l38.88-247.91H325.19l-18.46 112H205.21l-25.73-148h295.58l20.76-132c1.27-8.75-4.38-17.04-12.69-18.44z" />
    </svg>
  );
}

function GitlabIcon() {
  return (
    <svg viewBox="0 0 512 512" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M488.028 207.68l-.674-1.731-65.335-171.154a17.07 17.07 0 00-6.723-8.129 17.445 17.445 0 00-19.995 1.08 17.568 17.568 0 00-5.799 8.83l-44.114 135.478H166.756L122.641 36.576a17.215 17.215 0 00-5.798-8.856 17.444 17.444 0 00-19.996-1.079 17.22 17.22 0 00-6.723 8.129l-65.46 171.078-.649 1.731a122.213 122.213 0 00-3.308 77.122c7.259 25.388 22.543 47.718 43.548 63.625l.225.175.6.427 99.526 74.814 49.238 37.407 29.993 22.73A20.118 20.118 0 00256.034 488c4.405 0 8.689-1.447 12.197-4.121l29.993-22.73 49.238-37.407 100.126-75.266.25-.2c20.958-15.91 36.207-38.217 43.454-63.57a122.26 122.26 0 00-3.264-77.026z" />
    </svg>
  );
}
