import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, Building2, Hammer, Package, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../api/client";

export function AdminOverviewPage() {
  const q = useQuery({ queryKey: ["admin", "stats"], queryFn: () => api.admin.stats(), refetchInterval: 4000 });

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">Overview</h1>
        </div>
      </header>

      <div className="admin-overview-grid">
        <StatTile to="/admin/users" icon={Users} label="Users" value={q.data?.users} />
        <StatTile to="/admin/orgs" icon={Building2} label="Organizations" value={q.data?.organizations} />
        <StatTile to="/admin/orgs" icon={Package} label="Apps" value={q.data?.apps} />
        <StatTile to="/admin/builds" icon={Hammer} label="Builds" value={q.data?.builds} />
        <StatTile to="/admin/builds" icon={Activity} label="Running / queued" value={q.data?.runningOrQueued} />
      </div>
    </div>
  );
}

function StatTile({
  to,
  icon: Icon,
  label,
  value,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  value: number | undefined;
}) {
  return (
    <Link to={to} className="admin-overview-tile">
      <span className="admin-overview-tile__icon" aria-hidden>
        <Icon size={20} />
      </span>
      <span className="admin-overview-tile__label">{label}</span>
      <span className="admin-overview-tile__value">{value ?? "—"}</span>
    </Link>
  );
}
