import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { api } from "../api/client";
import { formatFullDate, relativeTime } from "../lib/dates";

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  ownerUserId: string;
  createdAt: string;
  planId: string | null;
  planStatus: string | null;
}

export function AdminOrgsPage() {
  const q = useQuery({ queryKey: ["admin", "orgs"], queryFn: () => api.admin.orgs() });

  const orgs = (q.data ?? []) as OrgRow[];

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Organizations</h1>
      </header>

      {q.isLoading && <div className="builds-status">Loading organizations…</div>}
      {q.error && (
        <div className="builds-status is-error">{(q.error as Error).message}</div>
      )}

      {!q.isLoading && orgs.length === 0 && (
        <div className="empty-state">
          <h2 className="empty-state__title">No organizations</h2>
        </div>
      )}

      {!!orgs.length && (
        <div className="data-grid admin-orgs-table" role="table">
          <div className="data-grid__head" role="row">
            <span role="columnheader">Organization</span>
            <span role="columnheader">Plan</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Created</span>
            <span role="columnheader" aria-label="Open"></span>
          </div>
          {orgs.map((o) => (
            <OrgRowItem key={o.id} org={o} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrgRowItem({ org }: { org: OrgRow }) {
  const navigate = useNavigate();
  const goToDetail = () => navigate(`/admin/orgs/${org.id}`);

  const displayName = org.name;
  const fullDate = formatFullDate(org.createdAt);

  return (
    <div
      className="data-grid__row builds-row is-clickable"
      role="row"
      onClick={goToDetail}
    >
      <div role="cell" className="builds-row__triggered">
        <OrgAvatar seed={org.slug || org.id} name={displayName} />
        <div className="builds-row__triggered-meta">
          <span className="builds-row__triggered-name">{displayName}</span>
          <span className="builds-row__triggered-date">{org.slug}</span>
        </div>
      </div>
      <div role="cell">
        {org.planId ? (
          <code className="plan-card__id">{org.planId}</code>
        ) : (
          <span className="builds-row__deployment-empty">no plan</span>
        )}
      </div>
      <div role="cell">
        {org.planStatus ? (
          <span className={`status-pill is-${org.planStatus}`}>{org.planStatus.replace("_", " ")}</span>
        ) : (
          <span className="builds-row__deployment-empty">—</span>
        )}
      </div>
      <div role="cell" className="builds-row__commit-sub">
        <span className="tooltip-wrap" tabIndex={0} aria-label={fullDate}>
          {relativeTime(org.createdAt)}
          <span className="tooltip-bubble" role="tooltip">{fullDate}</span>
        </span>
      </div>
      <div role="cell" className="admin-plans-row__chevron">
        <ChevronRight size={16} aria-hidden />
      </div>
    </div>
  );
}

function OrgAvatar({ seed, name }: { seed: string; name: string }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const style = {
    background: `linear-gradient(135deg, hsl(${hue}, 70%, 78%) 0%, hsl(${(hue + 30) % 360}, 65%, 60%) 100%)`,
  };
  return (
    <span className="builds-row__commit-avatar" style={style} aria-hidden="true">
      <span className="apps-list__icon-letter">{letter}</span>
    </span>
  );
}
