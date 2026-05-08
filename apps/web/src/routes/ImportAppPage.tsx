import { useNavigate, useParams } from "react-router-dom";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@mobileflow/ui";
import { ApiError, api, type Runtime } from "../api/client";

const RUNTIMES: { id: Runtime; label: string }[] = [
  { id: "capacitor", label: "Capacitor" },
  { id: "cordova", label: "Cordova" },
  { id: "react_native", label: "React Native" },
  { id: "ios_native", label: "iOS Native" },
  { id: "android_native", label: "Android Native" },
];
const HOSTS: { id: "github" | "gitlab" | "bitbucket"; label: string }[] = [
  { id: "github", label: "GitHub" },
  { id: "gitlab", label: "GitLab" },
  { id: "bitbucket", label: "Bitbucket" },
];

export function ImportAppPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { orgId } = useParams();
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState<Runtime>("capacitor");
  const [host, setHost] = useState<(typeof HOSTS)[number]["id"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createApp = useMutation({
    mutationFn: () => api.createApp(orgId!, { name: name.trim(), runtime }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["apps", orgId] });
      if (host) {
        navigate(`/app/${created.id}/git`);
      } else {
        navigate(`/app/${created.id}/commits`);
      }
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not create app"),
  });

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Import App</h1>
        <Button variant="ghost" onClick={() => navigate(`/org/${orgId}/apps`)}>
          Close
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connect your repo</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-1.5">
            <Label htmlFor="name">App name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid gap-1.5">
            <Label>Native runtime</Label>
            <div className="flex flex-wrap gap-2">
              {RUNTIMES.map((r) => (
                <Button
                  key={r.id}
                  type="button"
                  variant={runtime === r.id ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRuntime(r.id)}
                >
                  {r.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Git host</Label>
            <div className="flex flex-wrap gap-2">
              {HOSTS.map((h) => (
                <Button
                  key={h.id}
                  type="button"
                  variant={host === h.id ? "default" : "outline"}
                  size="sm"
                  onClick={() => setHost(h.id)}
                >
                  {h.label}
                </Button>
              ))}
            </div>
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline text-left"
              onClick={() => setHost(null)}
            >
              Connect git host later
            </button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button
              onClick={() => createApp.mutate()}
              disabled={!name.trim() || createApp.isPending}
              loading={createApp.isPending}
            >
              Continue
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
