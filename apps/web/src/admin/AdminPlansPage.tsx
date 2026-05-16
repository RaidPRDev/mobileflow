import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, XCircle } from "lucide-react";
import { api } from "../api/client";

interface Plan {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  maxApps: number | null;
  maxSeats: number | null;
  maxConcurrentBuilds: number | null;
  canBuild: boolean;
  isInternal: boolean;
  sortOrder: number;
}

export function AdminPlansPage() {
  const q = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api.admin.plans() });

  const plans = q.data ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header__main">
          <h1 className="page-title">Plans</h1>
        </div>
      </header>
      <p className="page-subtitle">
        The <code>unlimited</code> plan is read-only and assignable only via the org detail page.
      </p>

      {q.isLoading && <div className="builds-status">Loading plans…</div>}
      {q.error && (
        <div className="builds-status is-error">{(q.error as Error).message}</div>
      )}

      {!q.isLoading && plans.length === 0 && (
        <div className="empty-state">
          <h2 className="empty-state__title">No plans</h2>
        </div>
      )}

      {!!plans.length && (
        <div className="data-grid admin-plans-table" role="table">
          <div className="data-grid__head" role="row">
            <span role="columnheader">Plan</span>
            <span role="columnheader">Price</span>
            <span role="columnheader">Apps</span>
            <span role="columnheader">Seats</span>
            <span role="columnheader">Concurrent</span>
            <span role="columnheader">Builds</span>
            <span role="columnheader" aria-label="Open"></span>
          </div>
          {plans.map((p) => (
            <PlanRow key={p.id} plan={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanRow({ plan }: { plan: Plan }) {
  const navigate = useNavigate();
  const goToEdit = () => navigate(`/admin/plans/${plan.id}`);

  return (
    <div className="data-grid__row builds-row is-clickable" role="row" onClick={goToEdit}>
      <div role="cell">
        <div className="plan-card__title-block">
          <span className="builds-row__triggered-name">{plan.name}</span>
          <code className="plan-card__id">{plan.id}</code>
          {plan.isInternal && (
            <span className="plan-card__readonly">read-only</span>
          )}
        </div>
      </div>
      <div role="cell" className="builds-row__platform-label">
        {formatPrice(plan.priceCents, plan.currency)}
      </div>
      <div role="cell" className="admin-plans-row__num">
        {formatLimit(plan.maxApps)}
      </div>
      <div role="cell" className="admin-plans-row__num">
        {formatLimit(plan.maxSeats)}
      </div>
      <div role="cell" className="admin-plans-row__num">
        {formatLimit(plan.maxConcurrentBuilds)}
      </div>
      <div role="cell" className="builds-row__status">
        {plan.canBuild ? (
          <span className="tooltip-wrap" tabIndex={0}>
            <CheckCircle2 size={18} className="status-icon is-success" aria-hidden />
            <span className="tooltip-bubble" role="tooltip">Builds enabled</span>
          </span>
        ) : (
          <span className="tooltip-wrap" tabIndex={0}>
            <XCircle size={18} className="status-icon is-failed" aria-hidden />
            <span className="tooltip-bubble" role="tooltip">Builds disabled</span>
          </span>
        )}
      </div>
      <div role="cell" className="admin-plans-row__chevron">
        <ChevronRight size={16} aria-hidden />
      </div>
    </div>
  );
}

function formatPrice(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  const code = (currency || "USD").toUpperCase();
  return code === "USD" ? `$${amount}` : `${amount} ${code}`;
}

function formatLimit(value: number | null): string {
  return value === null ? "∞" : String(value);
}
