import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { api } from "../api/client";

const STATUS_CLASS: Record<string, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-primary/15 text-primary",
  success: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

export function AdminBuildsPage() {
  const q = useQuery({
    queryKey: ["admin", "builds"],
    queryFn: () => api.admin.builds(),
    refetchInterval: 3000,
  });

  return (
    <div className="grid gap-4 max-w-6xl">
      <h1 className="text-2xl font-semibold">Builds (cross-org)</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent {q.data?.length ?? "—"}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {q.data?.map((b) => (
            <Link
              key={b.id}
              to={`/app/${b.appId}/build/builds/${b.id}`}
              className="flex items-center gap-3 border-b last:border-0 py-2 hover:bg-accent/40 -mx-2 px-2"
            >
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_CLASS[b.status] ?? "bg-muted"}`}>
                {b.status}
              </span>
              <span className="text-xs text-muted-foreground w-20 shrink-0">{b.target}</span>
              <span className="font-medium truncate flex-1">
                {b.orgName} / {b.appName}
              </span>
              <code className="text-xs text-muted-foreground">{b.commitSha.slice(0, 7)}</code>
              <span className="text-xs text-muted-foreground hidden sm:inline">
                {new Date(b.createdAt).toLocaleString()}
              </span>
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
