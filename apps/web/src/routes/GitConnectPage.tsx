import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { ApiError, api, type GitProvider } from "../api/client";

const PROVIDERS: { id: GitProvider; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
  { id: "bitbucket", label: "Bitbucket" },
];

export function GitConnectPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<GitProvider>("github");

  const appQ = useQuery({ queryKey: ["app", appId], queryFn: () => api.getApp(appId!), enabled: !!appId });
  const orgId = appQ.data?.orgId;

  const connsQ = useQuery({
    queryKey: ["git-connections", orgId],
    queryFn: () => api.listGitConnections(orgId!),
    enabled: !!orgId,
  });

  const conn = connsQ.data?.find((c) => c.provider === tab);

  const reposQ = useQuery({
    queryKey: ["repos", conn?.id],
    queryFn: () => api.listRepos(conn!.id),
    enabled: !!conn,
  });

  const linkRepo = useMutation({
    mutationFn: (fullName: string) =>
      api.patchApp(appId!, { gitConnectionId: conn!.id, gitRepoFullName: fullName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app", appId] });
      navigate(`/app/${appId}/commits`);
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api.deleteGitConnection(conn!.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["git-connections", orgId] }),
  });

  if (appQ.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (appQ.error) return <p className="text-sm text-destructive">{(appQ.error as ApiError).message}</p>;

  return (
    <div className="max-w-3xl grid gap-4">
      <h1 className="text-2xl font-semibold">Connect a repository</h1>

      <div className="flex gap-2 border-b">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => setTab(p.id)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === p.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {!conn && orgId && (
        <Card>
          <CardHeader>
            <CardTitle>Connect {PROVIDERS.find((p) => p.id === tab)?.label}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Authorize MobileFlow to access your repositories.
            </p>
            <Button
              onClick={() => {
                const returnTo = `/app/${appId}/git`;
                const qs = new URLSearchParams({ orgId, returnTo }).toString();
                window.location.href = `/api/orgs/git-connections/${tab}/start?${qs}`;
              }}
            >
              Connect {PROVIDERS.find((p) => p.id === tab)?.label}
            </Button>
            <p className="text-xs text-muted-foreground">
              If this fails, an administrator may need to register the OAuth app under <code>Admin → OAuth apps</code>.
            </p>
          </CardContent>
        </Card>
      )}

      {conn && (
        <Card>
          <CardHeader>
            <CardTitle>
              Connected as {conn.accountLogin} ({conn.provider})
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {reposQ.isLoading && <p className="text-sm text-muted-foreground">Loading repos…</p>}
            {reposQ.error && <p className="text-sm text-destructive">{(reposQ.error as ApiError).message}</p>}
            {reposQ.data && (
              <div className="grid gap-2 max-h-[420px] overflow-auto">
                {reposQ.data.map((r) => (
                  <button
                    key={String(r.id)}
                    onClick={() => linkRepo.mutate(r.fullName)}
                    className="text-left rounded-md border p-3 hover:bg-accent/40"
                  >
                    <div className="font-medium">{r.fullName}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.private ? "Private" : "Public"} · default: {r.defaultBranch}
                      {r.description ? ` · ${r.description}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-between pt-2">
              <Button variant="ghost" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
                Disconnect
              </Button>
              <Button variant="outline" onClick={() => navigate(`/app/${appId}/commits`)}>
                Skip
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
