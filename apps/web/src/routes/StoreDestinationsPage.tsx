import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

type DestType = "app_store" | "testflight" | "play_store" | "play_internal";

const TYPE_LABEL: Record<DestType, string> = {
  app_store: "App Store",
  testflight: "TestFlight",
  play_store: "Google Play (Production)",
  play_internal: "Google Play (Internal)",
};

const TYPE_PLATFORM: Record<DestType, "ios" | "android"> = {
  app_store: "ios",
  testflight: "ios",
  play_store: "android",
  play_internal: "android",
};

export function StoreDestinationsPage() {
  const { appId } = useParams();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const q = useQuery({
    queryKey: ["destinations", appId],
    queryFn: () => api.listDestinations(appId!),
    enabled: !!appId,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDestination(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["destinations", appId] }),
  });

  return (
    <div className="grid gap-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Store destinations</h1>
        <Button onClick={() => setOpen((s) => !s)}>{open ? "Cancel" : "New store destination"}</Button>
      </div>

      {open && <NewDestCard appId={appId!} onDone={() => setOpen(false)} />}

      <div className="grid gap-2">
        {q.data?.map((d) => (
          <div key={d.id} className="rounded-md border bg-card p-3 flex items-center gap-3">
            <span className="text-xs uppercase rounded-full px-2 py-0.5 bg-muted">{TYPE_PLATFORM[d.type as DestType]}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{d.name}</div>
              <div className="text-xs text-muted-foreground">
                {TYPE_LABEL[d.type as DestType]}
                {d.bundleId ? ` · ${d.bundleId}` : ""}
                {d.trackOrChannel ? ` · ${d.trackOrChannel}` : ""}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => remove.mutate(d.id)}>
              Delete
            </Button>
          </div>
        ))}
        {q.data?.length === 0 && <p className="text-sm text-muted-foreground">No destinations yet.</p>}
      </div>
    </div>
  );
}

function NewDestCard({ appId, onDone }: { appId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<DestType>("testflight");
  const [name, setName] = useState("");
  const [bundleId, setBundleId] = useState("");
  const [track, setTrack] = useState<string>("internal");
  // iOS App Store Connect API key
  const [issuerId, setIssuerId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [p8, setP8] = useState("");
  // Android service account JSON
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const config =
        TYPE_PLATFORM[type] === "ios"
          ? { issuerId, keyId, privateKeyP8: p8 }
          : { serviceAccountJson };
      return api.createDestination(appId, {
        name: name.trim(),
        type,
        bundleId: bundleId.trim() || null,
        trackOrChannel: TYPE_PLATFORM[type] === "android" ? track : null,
        config,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["destinations", appId] });
      onDone();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New store destination</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          {(Object.keys(TYPE_LABEL) as DestType[]).map((t) => (
            <Button key={t} size="sm" variant={type === t ? "default" : "outline"} onClick={() => setType(t)}>
              {TYPE_LABEL[t]}
            </Button>
          ))}
        </div>
        <Field label="Display name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={TYPE_PLATFORM[type] === "ios" ? "Bundle ID" : "Application ID"}>
          <Input value={bundleId} onChange={(e) => setBundleId(e.target.value)} placeholder={TYPE_PLATFORM[type] === "ios" ? "com.acme.myapp" : "com.acme.myapp"} />
        </Field>

        {TYPE_PLATFORM[type] === "ios" ? (
          <>
            <Field label="App Store Connect — Issuer ID">
              <Input value={issuerId} onChange={(e) => setIssuerId(e.target.value)} />
            </Field>
            <Field label="Key ID">
              <Input value={keyId} onChange={(e) => setKeyId(e.target.value)} />
            </Field>
            <Field label="Private key (.p8)">
              <textarea
                className="h-32 rounded-md border border-input bg-background p-2 text-xs font-mono"
                value={p8}
                onChange={(e) => setP8(e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----..."
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Track">
              <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={track} onChange={(e) => setTrack(e.target.value)}>
                <option value="internal">internal</option>
                <option value="alpha">alpha</option>
                <option value="beta">beta</option>
                <option value="production">production</option>
              </select>
            </Field>
            <Field label="Service account JSON">
              <textarea
                className="h-32 rounded-md border border-input bg-background p-2 text-xs font-mono"
                value={serviceAccountJson}
                onChange={(e) => setServiceAccountJson(e.target.value)}
                placeholder='{"type":"service_account",...}'
              />
            </Field>
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onDone}>Cancel</Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
