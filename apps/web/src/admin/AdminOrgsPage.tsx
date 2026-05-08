import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

export function AdminOrgsPage() {
  const q = useQuery({ queryKey: ["admin", "orgs"], queryFn: () => api.admin.orgs() });

  return (
    <div className="grid gap-4 max-w-5xl">
      <h1 className="text-2xl font-semibold">Organizations</h1>
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      <ul className="grid gap-2">
        {q.data?.map((o) => (
          <li key={o.id}>
            <Link to={`/admin/orgs/${o.id}`} className="block rounded-md border bg-card p-3 hover:bg-accent/40">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{o.name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    <code>{o.slug}</code> · {new Date(o.createdAt).toLocaleString()}
                  </div>
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full bg-muted">
                  {o.planId ?? "no-plan"}
                </span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
