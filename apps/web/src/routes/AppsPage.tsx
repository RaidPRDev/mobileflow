import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { api } from "../api/client";

const RUNTIME_LABEL: Record<string, string> = {
  capacitor: "Capacitor",
  cordova: "Cordova",
  react_native: "React Native",
  ios_native: "iOS Native",
  android_native: "Android Native",
};

export function AppsPage() {
  const { orgId } = useParams();
  const { data: apps, isLoading, error } = useQuery({
    queryKey: ["apps", orgId],
    queryFn: () => api.listApps(orgId!),
    enabled: !!orgId,
  });

  return (
    <div className="grid gap-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Apps</h1>
          <p className="text-sm text-muted-foreground">Your imported apps in this organization.</p>
        </div>
        <Button asChild>
          <Link to={`/org/${orgId}/apps/import`}>New App</Link>
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {apps && apps.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No apps yet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">Import a repository to start building.</p>
            <Button asChild>
              <Link to={`/org/${orgId}/apps/import`}>Import App</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {apps && apps.length > 0 && (
        <div className="grid gap-3">
          {apps.map((a) => (
            <Link
              key={a.id}
              to={`/app/${a.id}/commits`}
              className="rounded-md border bg-card p-4 hover:bg-accent/40 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {RUNTIME_LABEL[a.runtime] ?? a.runtime} · {a.gitRepoFullName ?? "No repo connected"}
                  </div>
                </div>
                <code className="text-xs text-muted-foreground">{a.id}</code>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
