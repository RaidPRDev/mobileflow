import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

const PLAN_OPTIONS = ["naboria", "bohio", "yucayeque", "cacique", "unlimited"] as const;

export function AdminOrgDetailPage() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["admin", "org", orgId],
    queryFn: () => api.admin.org(orgId!),
    enabled: !!orgId,
  });

  const setPlan = useMutation({
    mutationFn: (planId: string) => api.admin.setOrgPlan(orgId!, planId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "org", orgId] }),
  });

  const remove = useMutation({
    mutationFn: () => api.admin.deleteOrg(orgId!),
    onSuccess: () => navigate("/admin/orgs"),
  });

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error) return <p className="text-sm text-destructive">{(q.error as ApiError).message}</p>;
  const data = q.data!;

  return (
    <div className="grid gap-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{data.org.name}</h1>
          <p className="text-xs text-muted-foreground font-mono">{data.org.id}</p>
        </div>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm(`Delete organization "${data.org.name}"? This cascades to apps + builds.`)) remove.mutate();
          }}
        >
          Delete organization
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plan</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 flex-wrap">
          {PLAN_OPTIONS.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={data.subscription?.planId === p ? "default" : "outline"}
              onClick={() => setPlan.mutate(p)}
              disabled={setPlan.isPending}
            >
              {p}
            </Button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members ({data.members.length})</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {data.members.map((m) => (
            <div key={m.userId} className="flex items-center justify-between border-b last:border-0 py-1">
              <span>
                {m.email} {m.isSuperadmin && <span className="text-xs uppercase ml-1 text-primary">superadmin</span>}
              </span>
              <span className="text-xs text-muted-foreground">{m.role}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Apps ({data.apps.length})</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {data.apps.map((a) => (
            <div key={a.id} className="flex items-center justify-between border-b last:border-0 py-1">
              <span>
                <code className="text-xs mr-2">{a.id}</code>
                {a.name}
              </span>
              <span className="text-xs text-muted-foreground">{a.runtime}</span>
            </div>
          ))}
          {data.apps.length === 0 && <p className="text-xs text-muted-foreground">No apps.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent builds</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {data.recentBuilds.map((b) => (
            <div key={b.id} className="flex items-center justify-between border-b last:border-0 py-1">
              <span>
                <code className="text-xs mr-2">{b.commitSha.slice(0, 7)}</code>
                {b.target}
              </span>
              <span className="text-xs text-muted-foreground">
                {b.status} · {new Date(b.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
          {data.recentBuilds.length === 0 && <p className="text-xs text-muted-foreground">No builds.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
