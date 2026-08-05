import { Link, useNavigate, useParams } from "react-router-dom";
import { useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button, Loading } from "@mobileflow/ui";
import { ExternalLink, GitBranch, Search } from "lucide-react";
import { ApiError, api, type CommitRow } from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";
import { useAdaptivePageSize } from "../lib/useAdaptivePageSize";
import { ListFooter } from "../components/ListFooter";
import { RowContextMenu } from "../components/RowActions";
import { allowNativeContextMenu } from "../lib/rowInteractions";

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

  // Commit row is ~72 px (avatar + two lines of meta). Anchor on the list
  // container so we measure space from its top down to the viewport.
  const listRef = useRef<HTMLDivElement>(null);
  const perPage = useAdaptivePageSize({
    rowHeight: 72,
    anchorRef: listRef,
    reserve: 90,
    min: 5,
    max: 30,
  });

  // No branch filter: the API merges every branch and labels each commit.
  const commitsQ = useQuery({
    queryKey: ["commits", appId, page, perPage],
    queryFn: () => api.listCommits(appId!, { page, perPage }),
    enabled: !!appQ.data?.gitRepoFullName,
    placeholderData: keepPreviousData,
  });
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
        (c.branch ?? "").toLowerCase().includes(q),
    );
  }, [commitsQ.data?.items, filter]);

  if (appQ.isLoading) {
    return (
      <div className="commits-page__status">
        <Loading />
      </div>
    );
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
          <Link to={`/app/${appId}/settings/git`}>Connect a repository</Link>
        </Button>
      </div>
    );
  }

  const totalCount = commitsQ.data?.totalCount;
  const hasNext = commitsQ.data?.hasNext ?? false;
  const startBuild = (c: CommitRow) => {
    const qs = new URLSearchParams({ commitId: c.sha });
    if (c.branch) qs.set("branch", c.branch);
    navigate(`/app/${appId}/build/builds/new?${qs}`);
  };

  return (
    <div className="commits-page">
      <div className="commits-page__header">
        <h1 className="page-title">Commits</h1>
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

      <div className="commits-list" ref={listRef}>
        {commitsQ.isLoading && (
          <div className="commits-page__status">
            <Loading>Loading commits…</Loading>
          </div>
        )}
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
            accountAvatarUrl={accountAvatarUrl}
            accountLogin={accountLogin}
            onStartBuild={() => startBuild(c)}
          />
        ))}
      </div>

      <ListFooter
        // `page` is 1-indexed; `pageCount` derives from totalCount when known,
        // otherwise we infer one more page exists whenever the API says
        // `hasNext` so the Next button stays clickable through unknown depths.
        pageIdx={page - 1}
        pageCount={
          totalCount != null
            ? Math.max(1, Math.ceil(totalCount / perPage))
            : page + (hasNext ? 1 : 0)
        }
        total={totalCount ?? undefined}
        unit="commit"
        countLabel={totalCount == null ? "" : undefined}
        busy={commitsQ.isFetching}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => p + 1)}
      />
    </div>
  );
}

interface CommitRowItemProps {
  commit: CommitRow;
  accountAvatarUrl: string | null;
  accountLogin: string | null;
  onStartBuild: () => void;
}

function CommitRowItem({ commit, accountAvatarUrl, accountLogin, onStartBuild }: CommitRowItemProps) {
  const title = commit.message.split("\n")[0] ?? "";
  const shortSha = commit.sha.slice(0, 6);
  const avatarSrc = accountAvatarUrl ?? commit.avatarUrl;
  const initial = (accountLogin || commit.authorName || "?").trim().charAt(0).toUpperCase();
  const avatarAlt = accountLogin ?? "";
  const fullDate = formatFullDate(commit.date);

  return (
    <RowContextMenu actions={[{ label: "Start build", onSelect: onStartBuild }]}>
      <div className="commit-row fade-in">
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
              // Right-clicking the hash should offer "Copy link address", not the
              // row menu.
              onContextMenu={allowNativeContextMenu}
            >
              <span className="commit-row__sha-text">{shortSha}</span>
              <ExternalLink size={11} aria-hidden />
              <span className="tooltip-bubble tooltip-bubble--start" role="tooltip">
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
            {commit.branch && (
              <>
                <span className="commit-row__from">from</span>
                <span className="commit-row__branch">
                  <GitBranch size={12} aria-hidden />
                  <span>{commit.branch}</span>
                </span>
              </>
            )}
          </div>
        </div>
        <div className="commit-row__action">
          <Button variant="outline" size="sm" onClick={onStartBuild}>
            Start build
          </Button>
        </div>
      </div>
    </RowContextMenu>
  );
}
