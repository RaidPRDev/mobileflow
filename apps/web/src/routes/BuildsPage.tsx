import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { ApiError, api, type BuildStatus } from "../api/client";

const STATUS_CLASS: Record<BuildStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-primary/15 text-primary",
  success: "bg-emerald-500/15 text-emerald-500",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

export function BuildsPage() {
  const { appId } = useParams();
  const buildsQ = useQuery({
    queryKey: ["builds", appId],
    queryFn: () => api.listBuilds(appId!),
    enabled: !!appId,
    refetchInterval: 4000,
  });

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Builds</h1>
        <Button asChild>
          <Link to={`/app/${appId}/commits`}>New Build</Link>
        </Button>
      </div>

      {buildsQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {buildsQ.error && <p className="text-sm text-destructive">{(buildsQ.error as ApiError).message}</p>}

      {buildsQ.data?.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No builds yet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Pick a commit to start your first build.
            </p>
          </CardContent>
        </Card>
      )}

      {!!buildsQ.data?.length && (
        <ul className="grid gap-2">
          {buildsQ.data.map((b) => (
            <li key={b.id}>
              <Link to={`/app/${appId}/builds/${b.id}`} className="block rounded-md border bg-card p-3 hover:bg-accent/40">
                <div className="flex items-center gap-3">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_CLASS[b.status]}`}
                  >
                    {b.status}
                  </span>
                  <div className="text-sm flex-1 min-w-0">
                    <div className="truncate">{b.commitMessage ?? b.commitSha.slice(0, 7)}</div>
                    <div className="text-xs text-muted-foreground">
                      {b.target} · {b.stackId} · {new Date(b.createdAt).toLocaleString()}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
