import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@mobileflow/ui";
import { ApiError, api, type BuildTarget } from "../api/client";

const TARGETS: { id: BuildTarget; label: string }[] = [
  { id: "ios", label: "iOS" },
  { id: "android", label: "Android" },
  { id: "web", label: "Web" },
];

const STACKS: Record<BuildTarget, { id: string; label: string }[]> = {
  ios: [
    { id: "ios-15", label: "Xcode 15" },
    { id: "ios-16", label: "Xcode 16" },
  ],
  android: [{ id: "android-default", label: "Android (default)" }],
  web: [{ id: "web-default", label: "Web (Node 20)" }],
};

const BUILD_TYPES: Record<BuildTarget, { id: string; label: string }[] | null> = {
  ios: [
    { id: "development", label: "Development" },
    { id: "adhoc", label: "Ad Hoc" },
    { id: "appstore", label: "App Store / TestFlight" },
  ],
  android: [
    { id: "debug", label: "Debug" },
    { id: "release", label: "Release" },
  ],
  web: null,
};

export function NewBuildPage() {
  const { appId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const sha = params.get("sha") ?? "";
  const message = params.get("message") ?? "";

  const [target, setTarget] = useState<BuildTarget>("android");
  const [stackId, setStackId] = useState<string>("android-default");
  const [buildType, setBuildType] = useState<string>("release");
  const [environmentId, setEnvironmentId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const envsQ = useQuery({
    queryKey: ["envs", appId],
    queryFn: () => api.listEnvironments(appId!),
    enabled: !!appId,
  });

  const onTargetChange = (t: BuildTarget) => {
    setTarget(t);
    setStackId(STACKS[t][0]!.id);
    const types = BUILD_TYPES[t];
    setBuildType(types ? types[0]!.id : "");
  };

  const start = useMutation({
    mutationFn: () =>
      api.startBuild(appId!, {
        commitSha: sha,
        commitMessage: message || undefined,
        target,
        stackId,
        buildType: buildType || undefined,
        environmentId: environmentId || undefined,
      }),
    onSuccess: (b) => navigate(`/app/${appId}/builds/${b.id}`),
    onError: (err) => setError(err instanceof ApiError ? err.message : "Failed to start build"),
  });

  if (!sha) {
    return <p className="text-sm text-destructive">Missing commit SHA. Pick a commit first.</p>;
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold mb-4">Create a new build</h1>
      <Card>
        <CardHeader>
          <CardTitle>For commit {sha.slice(0, 7)}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-1.5">
            <Label>Commit message</Label>
            <Input value={message} readOnly />
          </div>

          <div className="grid gap-1.5">
            <Label>Target</Label>
            <div className="flex gap-2">
              {TARGETS.map((t) => (
                <Button key={t.id} type="button" variant={target === t.id ? "default" : "outline"} size="sm" onClick={() => onTargetChange(t.id)}>
                  {t.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>Build stack</Label>
            <div className="flex flex-wrap gap-2">
              {STACKS[target].map((s) => (
                <Button key={s.id} type="button" variant={stackId === s.id ? "default" : "outline"} size="sm" onClick={() => setStackId(s.id)}>
                  {s.label}
                </Button>
              ))}
            </div>
          </div>

          {BUILD_TYPES[target] && (
            <div className="grid gap-1.5">
              <Label>Build type</Label>
              <div className="flex flex-wrap gap-2">
                {BUILD_TYPES[target]!.map((bt) => (
                  <Button key={bt.id} type="button" variant={buildType === bt.id ? "default" : "outline"} size="sm" onClick={() => setBuildType(bt.id)}>
                    {bt.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="env">Environment (optional)</Label>
            <select
              id="env"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={environmentId}
              onChange={(e) => setEnvironmentId(e.target.value)}
            >
              <option value="">— None —</option>
              {envsQ.data?.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
            <Button onClick={() => start.mutate()} loading={start.isPending}>Build</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
