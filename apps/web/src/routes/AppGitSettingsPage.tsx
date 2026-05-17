import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "@mobileflow/ui";
import { Check, ChevronDown, Lock, Search, X } from "lucide-react";
import { ApiError, api, type GitProvider } from "../api/client";

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

export function AppGitSettingsPage() {
  const { appId } = useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState<GitProvider>("github");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const REPOS_PER_PAGE = 10;

  const appQ = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.getApp(appId!),
    enabled: !!appId,
  });
  const app = appQ.data;
  const orgId = app?.orgId;

  const connsQ = useQuery({
    queryKey: ["git-connections", orgId],
    queryFn: () => api.listGitConnections(orgId!),
    enabled: !!orgId,
  });
  const conn = (connsQ.data ?? []).find((c) => c.provider === tab) ?? null;

  // If the app is already linked to a repo, lock the tab to that provider's
  // connection so we show the "Connected to X" state.
  const linkedConn = (connsQ.data ?? []).find((c) => c.id === app?.gitConnectionId) ?? null;
  const isLinked = !!app?.gitRepoFullName && !!linkedConn && linkedConn.provider === tab;

  const reposQ = useQuery({
    queryKey: ["repos", conn?.id],
    queryFn: () => api.listRepos(conn!.id),
    enabled: !!conn && !isLinked,
  });

  const filteredRepos = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = reposQ.data ?? [];
    return q ? list.filter((r) => r.fullName.toLowerCase().includes(q)) : list;
  }, [reposQ.data, filter]);

  const totalPages = Math.max(1, Math.ceil(filteredRepos.length / REPOS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pagedRepos = filteredRepos.slice(
    (safePage - 1) * REPOS_PER_PAGE,
    safePage * REPOS_PER_PAGE,
  );

  const linkRepo = useMutation({
    mutationFn: (fullName: string) =>
      api.patchApp(appId!, {
        gitConnectionId: conn!.id,
        gitRepoFullName: fullName,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app", appId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not link repo"),
  });

  const disconnect = useMutation({
    mutationFn: () =>
      api.patchApp(appId!, {
        gitConnectionId: null,
        gitRepoFullName: null,
        gitDefaultBranch: null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app", appId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not disconnect"),
  });

  if (appQ.isLoading) return <p className="settings-page__status">Loading…</p>;
  if (appQ.error)
    return <p className="settings-page__status is-danger">{(appQ.error as ApiError).message}</p>;
  if (!app) return null;

  const hostDef = HOSTS.find((h) => h.id === tab) ?? HOSTS[0]!;

  function handleConnect() {
    if (!orgId) return;
    const returnTo = `/app/${appId}/settings/git`;
    const qs = new URLSearchParams({ orgId, returnTo }).toString();
    window.location.href = `/api/orgs/git-connections/${tab}/start?${qs}`;
  }

  return (
    <div className="page settings-page">
      <div className="settings-page__breadcrumb">
        <span>Settings</span>
        <span className="settings-page__sep">/</span>
        <span className="settings-page__crumb-current">Git</span>
      </div>
      <div className="page-header">
        <h1 className="page-title">Git</h1>
      </div>

      <div className="git-tabs">
        {HOSTS.map((h) => (
          <button
            key={h.id}
            type="button"
            className={`git-tab${tab === h.id ? " is-active" : ""}`}
            onClick={() => {
              setTab(h.id);
              setFilter("");
              setPage(1);
              setError(null);
            }}
          >
            <span className="git-tab__icon" style={{ background: h.bg }}>
              {h.icon}
            </span>
            <span className="git-tab__label">{h.label}</span>
          </button>
        ))}
      </div>

      {/* Connected to a repo for this provider */}
      {isLinked && linkedConn && (
        <div className="git-connected-row">
          <span className="git-connected-row__check" aria-hidden>
            <Check size={14} />
          </span>
          <div className="git-connected-row__text">
            Connected to{" "}
            <a
              className="git-connected-row__link"
              href={repoUrl(linkedConn.provider, app.gitRepoFullName!)}
              target="_blank"
              rel="noreferrer"
            >
              {app.gitRepoFullName}
            </a>{" "}
            on {hostDef.label}
          </div>
          <Button
            variant="outline"
            className="btn-danger-outline"
            onClick={() => disconnect.mutate()}
            loading={disconnect.isPending}
          >
            Disconnect
          </Button>
        </div>
      )}

      {/* Not connected at the org level for this provider */}
      {!isLinked && !conn && (
        <div className="git-connect-row">
          <span className="git-connect-row__icon" style={{ background: hostDef.bg }}>
            {hostDef.icon}
          </span>
          <div className="git-connect-row__text">
            <div className="git-connect-row__title">Connect to {hostDef.label}</div>
            <div className="git-connect-row__sub">
              Connect your{app.name ? ` ${app.name}` : ""} app to {hostDef.label} to enable code
              diffs and deploys.
            </div>
          </div>
          <Button onClick={handleConnect}>Connect to {hostDef.label}</Button>
        </div>
      )}

      {/* Connected at org level, but no repo linked yet for this app */}
      {!isLinked && conn && (
        <div className="settings-section">
          <div className="settings-section__label">Select a repository</div>
          <div className="git-repo-controls">
            <div className="git-repo-account">
              <span className="git-repo-account__icon" style={{ background: hostDef.bg }}>
                {hostDef.icon}
              </span>
              <span className="git-repo-account__name">{conn.accountLogin}</span>
              <ChevronDown size={14} className="git-repo-account__chev" aria-hidden />
            </div>
            <div className="git-repo-search">
              <Search size={14} className="git-repo-search__icon" aria-hidden />
              <input
                className="git-repo-search__input"
                placeholder="Find a repository..."
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setPage(1);
                }}
              />
              {filter && (
                <button
                  type="button"
                  className="git-repo-search__clear"
                  aria-label="Clear search"
                  onClick={() => setFilter("")}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          <div className="git-repos">
            {reposQ.isLoading && <div className="git-repos__empty">Loading repositories…</div>}
            {reposQ.error && (
              <div className="git-repos__empty is-error">{(reposQ.error as ApiError).message}</div>
            )}
            {!reposQ.isLoading &&
              !reposQ.error &&
              filteredRepos.length === 0 &&
              (reposQ.data?.length ?? 0) === 0 && (
                <div className="git-repos__empty">No repositories found for this account.</div>
              )}
            {!reposQ.isLoading &&
              !reposQ.error &&
              filteredRepos.length === 0 &&
              (reposQ.data?.length ?? 0) > 0 && (
                <div className="git-repos__empty">No repositories match "{filter}".</div>
              )}
            {pagedRepos.map((r) => (
              <button
                key={String(r.id)}
                type="button"
                className="git-repo"
                onClick={() => linkRepo.mutate(r.fullName)}
                disabled={linkRepo.isPending}
              >
                <span className="git-repo__icon">{hostDef.icon}</span>
                <span className="git-repo__name">{r.fullName}</span>
                {r.private && (
                  <span className="git-repo__lock" aria-label="Private">
                    <Lock size={12} />
                  </span>
                )}
              </button>
            ))}
          </div>

          {filteredRepos.length > REPOS_PER_PAGE && (
            <div className="git-repos__pager">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}

      {error && <p className="settings-page__error">{error}</p>}
    </div>
  );
}

function repoUrl(provider: GitProvider, fullName: string): string {
  if (provider === "github") return `https://github.com/${fullName}`;
  if (provider === "gitlab") return `https://gitlab.com/${fullName}`;
  return `https://bitbucket.org/${fullName}`;
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 512 512" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M256 32C132.3 32 32 134.9 32 261.7c0 101.5 64.2 187.5 153.2 217.9a17.56 17.56 0 003.8.4c8.3 0 11.5-6.1 11.5-11.4 0-5.5-.2-19.9-.3-39.1a102.4 102.4 0 01-22.6 2.7c-43.1 0-52.9-33.5-52.9-33.5-10.2-26.5-24.9-33.6-24.9-33.6-19.5-13.7-.1-14.1 1.4-14.1h.1c22.5 2 34.3 23.8 34.3 23.8 11.2 19.6 26.2 25.1 39.6 25.1a63 63 0 0025.6-6c2-14.8 7.8-24.9 14.2-30.7-49.7-5.8-102-25.5-102-113.5 0-25.1 8.7-45.6 23-61.6-2.3-5.8-10-29.2 2.2-60.8a18.64 18.64 0 015-.5c8.1 0 26.4 3.1 56.6 24.1a208.21 208.21 0 01112.2 0c30.2-21 48.5-24.1 56.6-24.1a18.64 18.64 0 015 .5c12.2 31.6 4.5 55 2.2 60.8 14.3 16.1 23 36.6 23 61.6 0 88.2-52.4 107.6-102.3 113.3 8 7.1 15.2 21.1 15.2 42.5 0 30.7-.3 55.5-.3 63 0 5.4 3.1 11.5 11.4 11.5a19.35 19.35 0 004-.4C415.9 449.2 480 363.1 480 261.7 480 134.9 379.7 32 256 32z" />
    </svg>
  );
}

function BitbucketIcon() {
  return (
    <svg viewBox="0 0 512 512" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M483.13 32.23a19.65 19.65 0 00-2.54-.23h-449C23 31.88 16.12 38.88 16 47.75a11.44 11.44 0 00.23 2.8l65.3 411.25a22.52 22.52 0 007 12.95A20 20 0 00102 480h313.18a15.45 15.45 0 0015.34-13.42l38.88-247.91H325.19l-18.46 112H205.21l-25.73-148h295.58l20.76-132c1.27-8.75-4.38-17.04-12.69-18.44z" />
    </svg>
  );
}

function GitlabIcon() {
  return (
    <svg viewBox="0 0 512 512" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M488.028 207.68l-.674-1.731-65.335-171.154a17.07 17.07 0 00-6.723-8.129 17.445 17.445 0 00-19.995 1.08 17.568 17.568 0 00-5.799 8.83l-44.114 135.478H166.756L122.641 36.576a17.215 17.215 0 00-5.798-8.856 17.444 17.444 0 00-19.996-1.079 17.22 17.22 0 00-6.723 8.129l-65.46 171.078-.649 1.731a122.213 122.213 0 00-3.308 77.122c7.259 25.388 22.543 47.718 43.548 63.625l.225.175.6.427 99.526 74.814 49.238 37.407 29.993 22.73A20.118 20.118 0 00256.034 488c4.405 0 8.689-1.447 12.197-4.121l29.993-22.73 49.238-37.407 100.126-75.266.25-.2c20.958-15.91 36.207-38.217 43.454-63.57a122.26 122.26 0 00-3.264-77.026z" />
    </svg>
  );
}
