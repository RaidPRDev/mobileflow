import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Github, Globe, MoreVertical } from "lucide-react";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Label,
  cn,
} from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

type Provider = "google" | "github" | "gitlab" | "bitbucket";
type Kind = "signin" | "git";

interface Slot {
  provider: Provider;
  kind: Kind;
  label: string;
  redirect: string;
}

const ALL: Slot[] = [
  {
    provider: "google",
    kind: "signin",
    label: "Google · sign-in",
    redirect: "/api/auth/oauth/google/callback",
  },
  {
    provider: "github",
    kind: "signin",
    label: "GitHub · sign-in",
    redirect: "/api/auth/oauth/github/callback",
  },
  {
    provider: "github",
    kind: "git",
    label: "GitHub · git connection",
    redirect: "/api/orgs/git-connections/github/callback",
  },
  {
    provider: "gitlab",
    kind: "git",
    label: "GitLab · git connection",
    redirect: "/api/orgs/git-connections/gitlab/callback",
  },
  {
    provider: "bitbucket",
    kind: "git",
    label: "Bitbucket · git connection",
    redirect: "/api/orgs/git-connections/bitbucket/callback",
  },
];

function providerIcon(provider: Provider) {
  switch (provider) {
    case "google":
      return <span className="svc-icon is-google" aria-hidden>G</span>;
    case "github":
      return <span className="svc-icon is-github"><Github size={14} /></span>;
    case "gitlab":
      return <span className="svc-icon is-gitlab" aria-hidden>GL</span>;
    case "bitbucket":
      return <span className="svc-icon is-bitbucket" aria-hidden>BB</span>;
    default:
      return <Globe size={16} />;
  }
}

export function AdminOAuthAppsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "oauth-apps"],
    queryFn: () => api.admin.oauthApps(),
  });

  const upsert = useMutation({
    mutationFn: (body: Parameters<typeof api.admin.upsertOAuthApp>[0]) =>
      api.admin.upsertOAuthApp(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "oauth-apps"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.admin.deleteOAuthApp(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "oauth-apps"] }),
  });

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">OAuth Apps</h1>
      </div>
      <p className="text-help">
        Register OAuth client credentials per provider. Sign-in apps gate user authentication; git
        apps gate repo connections (need <code>repo</code>-equivalent scope). DB rows take
        precedence over env vars.
      </p>

      <div className="page-section stack-sm">
        {ALL.map((slot) => {
          const existing = q.data?.find(
            (a) => a.provider === slot.provider && a.kind === slot.kind,
          );
          return (
            <ProviderCard
              key={`${slot.provider}-${slot.kind}`}
              slot={slot}
              existing={existing}
              onSave={(body) => upsert.mutate(body)}
              onDelete={() => existing && remove.mutate(existing.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function ProviderCard({
  slot,
  existing,
  onSave,
  onDelete,
}: {
  slot: Slot;
  existing:
    | { id: string; clientId: string; scopes: string | null; enabled: boolean }
    | undefined;
  onSave: (body: Parameters<typeof api.admin.upsertOAuthApp>[0]) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false); // collapsed by default
  const [clientId, setClientId] = useState(existing?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(existing?.scopes ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    try {
      onSave({
        provider: slot.provider,
        kind: slot.kind,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        scopes: scopes.trim() || null,
      });
      setClientSecret("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <div className={cn("accordion-item", open && "is-open")}>
      <div className="accordion-header">
        <button
          type="button"
          className={cn("accordion-trigger", open && "is-open")}
          onClick={() => setOpen((s) => !s)}
          aria-expanded={open}
        >
          <span className="accordion-trigger-content">
            {providerIcon(slot.provider)}
            <span style={{ fontWeight: 500 }}>{slot.label}</span>
            {existing ? (
              <Badge variant="success">Configured</Badge>
            ) : (
              <Badge variant="outline">Not configured</Badge>
            )}
          </span>
          <ChevronDown size={16} className="accordion-chevron" />
        </button>
        {existing && (
          <div className="accordion-actions">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton variant="menu" aria-label="More actions">
                  <MoreVertical size={16} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setOpen(true)}>Edit</DropdownMenuItem>
                <DropdownMenuItem
                  destructive
                  onSelect={() => {
                    if (confirm("Remove configuration?")) onDelete();
                  }}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {open && (
        <div className="accordion-panel is-padded-top">
          <p className="text-help">
            Set the redirect URI in the provider console to{" "}
            <code>{`<API_BASE_URL>${slot.redirect}`}</code>.
          </p>
          <div className="field-group">
            <Label className="is-small">Client ID</Label>
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </div>
          <div className="field-group">
            <Label className="is-small">
              Client secret {existing && "(leave blank to keep)"}
            </Label>
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
          <div className="field-group">
            <Label className="is-small">Scopes (optional, falls back to defaults)</Label>
            <Input
              value={scopes}
              onChange={(e) => setScopes(e.target.value)}
              placeholder={slot.kind === "git" ? "repo" : "read:user user:email"}
            />
          </div>
          {error && <p className="text-error">{error}</p>}
          <div className="row-end">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!clientId || (!existing && !clientSecret)}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
