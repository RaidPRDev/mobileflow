import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label } from "@mobileflow/ui";
import { ApiError, api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";

type Platform = "ios" | "android";

export function CertificatesPage() {
  const { appId } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();

  const appQ = useQuery({ queryKey: ["app", appId], queryFn: () => api.getApp(appId!), enabled: !!appId });
  const orgId = appQ.data?.orgId ?? me?.organizations[0]?.orgId ?? null;

  const certsQ = useQuery({
    queryKey: ["certs", orgId],
    queryFn: () => api.listCertificates(orgId!),
    enabled: !!orgId,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCertificate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["certs", orgId] }),
  });

  const [open, setOpen] = useState(false);

  return (
    <div className="max-w-3xl grid gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Signing Certificates</h1>
        <Button onClick={() => setOpen(true)}>Add certificate</Button>
      </div>

      {open && orgId && <AddCertCard orgId={orgId} onClose={() => setOpen(false)} />}

      {certsQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {certsQ.error && <p className="text-sm text-destructive">{(certsQ.error as ApiError).message}</p>}

      <div className="grid gap-2">
        {certsQ.data?.map((c) => (
          <div key={c.id} className="rounded-md border bg-card p-3 flex items-center gap-3">
            <span className="text-xs uppercase rounded-full px-2 py-0.5 bg-muted">{c.platform}</span>
            <span className="text-xs uppercase rounded-full px-2 py-0.5 bg-muted">{c.kind}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{c.label}</div>
              <div className="text-xs text-muted-foreground truncate">{c.fileName}</div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => remove.mutate(c.id)}>
              Delete
            </Button>
          </div>
        ))}
        {certsQ.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No certificates yet.</p>
        )}
      </div>
    </div>
  );
}

function AddCertCard({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [platform, setPlatform] = useState<Platform>("android");
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [alias, setAlias] = useState("");
  const [provisionId, setProvisionId] = useState("");
  const [provisionName, setProvisionName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isIos = platform === "ios";
  const kind = isIos ? "p12" : "keystore"; // alpha: one cert at a time

  const create = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Select a file");
      const buf = await file.arrayBuffer();
      const fileBase64 = btoa(
        Array.from(new Uint8Array(buf))
          .map((b) => String.fromCharCode(b))
          .join(""),
      );
      const metadata: Record<string, string> = isIos
        ? { provisionId, provisionName }
        : { alias };
      return api.createCertificate(orgId, {
        platform,
        kind,
        label: label.trim(),
        fileName: file.name,
        fileBase64,
        password: password || undefined,
        metadata,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["certs", orgId] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add certificate</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex gap-2">
          <Button size="sm" variant={platform === "ios" ? "default" : "outline"} onClick={() => setPlatform("ios")}>
            iOS
          </Button>
          <Button size="sm" variant={platform === "android" ? "default" : "outline"} onClick={() => setPlatform("android")}>
            Android
          </Button>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="cert-label">Label</Label>
          <Input id="cert-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={isIos ? "iOS Distribution" : "Production keystore"} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="cert-file">{isIos ? ".p12 file" : "Keystore (.jks / .keystore)"}</Label>
          <input
            id="cert-file"
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
            accept={isIos ? ".p12,.cer" : ".jks,.keystore"}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="cert-pass">{isIos ? "Certificate password" : "Keystore password"}</Label>
          <Input id="cert-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>

        {isIos ? (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="prov-id">Provisioning profile ID (optional)</Label>
              <Input id="prov-id" value={provisionId} onChange={(e) => setProvisionId(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prov-name">Provisioning profile name (optional)</Label>
              <Input id="prov-name" value={provisionName} onChange={(e) => setProvisionName(e.target.value)} />
            </div>
          </>
        ) : (
          <div className="grid gap-1.5">
            <Label htmlFor="alias">Key alias</Label>
            <Input id="alias" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="key0" />
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!file || !label.trim() || create.isPending} loading={create.isPending}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
