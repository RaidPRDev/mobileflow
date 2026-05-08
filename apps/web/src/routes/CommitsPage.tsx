import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

export function CommitsPage() {
  const { appId } = useParams();
  const navigate = useNavigate();

  const appQ = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.getApp(appId!),
    enabled: !!appId,
  });

  const commitsQ = useQuery({
    queryKey: ["commits", appId],
    queryFn: () => api.listCommits(appId!),
    enabled: !!appQ.data?.gitRepoFullName,
  });

  if (appQ.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (appQ.error) return <p className="text-sm text-destructive">{(appQ.error as ApiError).message}</p>;

  if (!appQ.data?.gitRepoFullName) {
    return (
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Connect your app</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Connect a repository to see commits and start builds.
          </p>
          <Button asChild>
            <Link to={`/app/${appId}/git`}>Connect a repository</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold">Commits</h1>
        <span className="text-xs text-muted-foreground font-mono">{appQ.data.gitRepoFullName}</span>
      </div>
      {commitsQ.isLoading && <p className="text-sm text-muted-foreground">Loading commits…</p>}
      {commitsQ.error && <p className="text-sm text-destructive">{(commitsQ.error as ApiError).message}</p>}
      {commitsQ.data && (
        <ul className="grid gap-2">
          {commitsQ.data.map((c) => (
            <li key={c.sha} className="rounded-md border bg-card p-3 flex items-center gap-3">
              {c.avatarUrl && <img src={c.avatarUrl} alt="" className="h-7 w-7 rounded-full" />}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{c.message.split("\n")[0]}</div>
                <div className="text-xs text-muted-foreground">
                  <code>{c.sha.slice(0, 7)}</code> · {c.authorName} ·{" "}
                  {new Date(c.date).toLocaleString()}
                </div>
              </div>
              <Button
                size="sm"
                onClick={() =>
                  navigate(
                    `/app/${appId}/builds/new?sha=${c.sha}&message=${encodeURIComponent(c.message.split("\n")[0] ?? "")}`,
                  )
                }
              >
                Start build
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
