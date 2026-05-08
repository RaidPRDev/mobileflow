import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

type Provider = "google" | "github" | "gitlab" | "bitbucket";
type Kind = "signin" | "git";

const ALL: { provider: Provider; kind: Kind; label: string; redirect: string }[] = [
  { provider: "google", kind: "signin", label: "Google · sign-in", redirect: "/api/auth/oauth/google/callback" },
  { provider: "github", kind: "signin", label: "GitHub · sign-in", redirect: "/api/auth/oauth/github/callback" },
  { provider: "github", kind: "git", label: "GitHub · git connection", redirect: "/api/orgs/git-connections/github/callback" },
  { provider: "gitlab", kind: "git", label: "GitLab · git connection", redirect: "/api/orgs/git-connections/gitlab/callback" },
  { provider: "bitbucket", kind: "git", label: "Bitbucket · git connection", redirect: "/api/orgs/git-connections/bitbucket/callback" },
];

export function AdminOAuthAppsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "oauth-apps"], queryFn: () => api.admin.oauthApps() });

  const upsert = useMutation({
    mutationFn: (body: Parameters<typeof api.admin.upsertOAuthApp>[0]) => api.admin.upsertOAuthApp(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "oauth-apps"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.admin.deleteOAuthApp(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "oauth-apps"] }),
  });

  return (
    <div className="grid gap-4 max-w-4xl">
      <h1 className="text-2xl font-semibold">OAuth Apps</h1>
      <p className="text-sm text-muted-foreground">
        Register OAuth client credentials per provider. Sign-in apps gate user authentication; git apps
        gate repo connections (need <code>repo</code>-equivalent scope). DB rows take precedence over env vars.
      </p>

      {ALL.map((slot) => {
        const existing = q.data?.find((a) => a.provider === slot.provider && a.kind === slot.kind);
        return (
          <ProviderCard
            key={`${slot.provider}-${slot.kind}`}
            provider={slot.provider}
            kind={slot.kind}
            label={slot.label}
            redirect={slot.redirect}
            existing={existing}
            onSave={(body) => upsert.mutate(body)}
            onDelete={() => existing && remove.mutate(existing.id)}
          />
        );
      })}
    </div>
  );
}

function ProviderCard({
  provider,
  kind,
  label,
  redirect,
  existing,
  onSave,
  onDelete,
}: {
  provider: Provider;
  kind: Kind;
  label: string;
  redirect: string;
  existing: { id: string; clientId: string; scopes: string | null; enabled: boolean } | undefined;
  onSave: (body: Parameters<typeof api.admin.upsertOAuthApp>[0]) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(!existing);
  const [clientId, setClientId] = useState(existing?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(existing?.scopes ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    try {
      onSave({ provider, kind, clientId: clientId.trim(), clientSecret: clientSecret.trim(), scopes: scopes.trim() || null });
      setClientSecret("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          {label}
          {existing ? (
            <span className="text-xs uppercase rounded-full px-2 py-0.5 bg-emerald-500/15 text-emerald-500">configured</span>
          ) : (
            <span className="text-xs uppercase rounded-full px-2 py-0.5 bg-muted text-muted-foreground">not configured</span>
          )}
        </CardTitle>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen((s) => !s)}>
            {open ? "Hide" : existing ? "Edit" : "Configure"}
          </Button>
          {existing && (
            <Button size="sm" variant="ghost" onClick={() => confirm("Remove configuration?") && onDelete()}>
              Remove
            </Button>
          )}
        </div>
      </CardHeader>
      {open && (
        <CardContent className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            Set the redirect URI in the provider console to <code>{`<API_BASE_URL>${redirect}`}</code>.
          </p>
          <div className="grid gap-1.5">
            <Label className="text-xs">Client ID</Label>
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Client secret {existing && "(leave blank to keep)"}</Label>
            <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Scopes (optional, falls back to defaults)</Label>
            <Input value={scopes} onChange={(e) => setScopes(e.target.value)} placeholder={kind === "git" ? "repo" : "read:user user:email"} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button onClick={submit} disabled={!clientId || (!existing && !clientSecret)}>
              Save
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
