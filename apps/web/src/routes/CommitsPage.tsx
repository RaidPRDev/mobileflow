import { Link, useNavigate, useParams } from "react-router-dom";
import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button } from "@mobileflow/ui";
import { ExternalLink, GitBranch, Search } from "lucide-react";
import { ApiError, api, type CommitRow } from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";

const PER_PAGE = 10;

export function CommitsPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");

  const appQ = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.getApp(appId!),
    enabled: !!appId,
  });

  const commitsQ = useQuery({
    queryKey: ["commits", appId, page],
    queryFn: () => api.listCommits(appId!, { page, perPage: PER_PAGE }),
    enabled: !!appQ.data?.gitRepoFullName,
    placeholderData: keepPreviousData,
  });

  const branchName = appQ.data?.gitDefaultBranch ?? "main";
  const accountAvatarUrl = commitsQ.data?.accountAvatarUrl ?? null;
  const accountLogin = commitsQ.data?.accountLogin ?? null;

  const visibleCommits = useMemo(() => {
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

  if (appQ.isLoading) {
    return <div className="commits-page__status">Loading…</div>;
  }
  if (appQ.error) {
    return <div className="commits-page__status is-error">{(appQ.error as ApiError).message}</div>;
  }
  if (!appQ.data?.gitRepoFullName) {
    return (
      <div className="commits-empty">
        <h2 className="commits-empty__title">Connect your app</h2>
        <p className="commits-empty__body">
          Connect a repository to see commits and start builds.
        </p>
        <Button asChild>
          <Link to={`/app/${appId}/git`}>Connect a repository</Link>
        </Button>
      </div>
    );
  }

  const totalCount = commitsQ.data?.totalCount;
  const hasNext = commitsQ.data?.hasNext ?? false;
  const startBuild = (c: CommitRow) =>
    navigate(
      `/app/${appId}/builds/new?sha=${c.sha}&message=${encodeURIComponent(
        c.message.split("\n")[0] ?? "",
      )}`,
    );

  return (
    <div className="commits-page">
      <div className="commits-page__header">
        <h1 className="commits-page__title">Commits</h1>
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
        {!commitsQ.isLoading && !commitsQ.error && visibleCommits.length === 0 && (
          <div className="commits-page__status">
            {filter ? `No commits match "${filter}".` : "No commits to show."}
          </div>
        )}
        {visibleCommits.map((c) => (
          <CommitRowItem
            key={c.sha}
            commit={c}
            branchName={branchName}
            accountAvatarUrl={accountAvatarUrl}
            accountLogin={accountLogin}
            onStartBuild={() => startBuild(c)}
          />
        ))}
      </div>

      <div className="commits-footer">
        <span className="commits-footer__count">
          {totalCount != null
            ? `${totalCount.toLocaleString()} commit${totalCount === 1 ? "" : "s"}`
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
            disabled={!hasNext || commitsQ.isFetching}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

interface CommitRowItemProps {
  commit: CommitRow;
  branchName: string;
  accountAvatarUrl: string | null;
  accountLogin: string | null;
  onStartBuild: () => void;
}

function CommitRowItem({ commit, branchName, accountAvatarUrl, accountLogin, onStartBuild }: CommitRowItemProps) {
  const title = commit.message.split("\n")[0] ?? "";
  const shortSha = commit.sha.slice(0, 6);
  const avatarSrc = accountAvatarUrl ?? commit.avatarUrl;
  const initial = (accountLogin || commit.authorName || "?").trim().charAt(0).toUpperCase();
  const avatarAlt = accountLogin ?? "";
  const fullDate = formatFullDate(commit.date);

  return (
    <div className="commit-row">
      <div className="commit-row__avatar">
        {avatarSrc ? (
          <img src={avatarSrc} alt={avatarAlt} />
        ) : (
          <span className="commit-row__avatar-fallback">{initial}</span>
        )}
      </div>
      <div className="commit-row__main">
        <div className="commit-row__title">
          <a
            className="commit-row__sha tooltip-wrap"
            href={commit.url}
            target="_blank"
            rel="noreferrer"
          >
            <span className="commit-row__sha-text">{shortSha}</span>
            <ExternalLink size={11} aria-hidden />
            <span className="tooltip-bubble" role="tooltip">
              {commit.sha}
            </span>
          </a>
          <span className="commit-row__message">{title}</span>
        </div>
        <div className="commit-row__meta">
          <span className="commit-row__author">{commit.authorName}</span>
          <span className="commit-row__sep">·</span>
          <span
            className="tooltip-wrap commit-row__date"
            tabIndex={0}
            aria-label={fullDate}
          >
            {relativeTime(commit.date)}
            <span className="tooltip-bubble" role="tooltip">
              {fullDate}
            </span>
          </span>
          <span className="commit-row__from">from</span>
          <span className="commit-row__branch">
            <GitBranch size={12} aria-hidden />
            <span>{branchName}</span>
          </span>
        </div>
      </div>
      <div className="commit-row__action">
        <Button variant="outline" size="sm" onClick={onStartBuild}>
          Start build
        </Button>
      </div>
    </div>
  );
}
