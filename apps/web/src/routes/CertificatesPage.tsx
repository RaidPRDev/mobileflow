import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Apple, ChevronDown, MoreVertical, Smartphone } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FileDrop,
  IconButton,
  Input,
  Label,
} from "@mobileflow/ui";
import { ApiError, api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";

type Platform = "ios" | "android";

export function CertificatesPage() {
  const { appId } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();

  const appQ = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.getApp(appId!),
    enabled: !!appId,
  });
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

  const [openPlatform, setOpenPlatform] = useState<Platform | null>(null);

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Signing Certificates</h1>
        <div className="page-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                Add certificate
                <ChevronDown size={14} className="btn-caret" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                icon={<Apple size={14} />}
                onSelect={() => setOpenPlatform("ios")}
              >
                iOS
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<Smartphone size={14} />}
                onSelect={() => setOpenPlatform("android")}
              >
                Android
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {openPlatform && orgId && (
        <AddCertDialog
          orgId={orgId}
          platform={openPlatform}
          onClose={() => setOpenPlatform(null)}
        />
      )}

      {certsQ.isLoading && <p className="text-help">Loading…</p>}
      {certsQ.error && <p className="text-error">{(certsQ.error as ApiError).message}</p>}

      <div className="page-section">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Platform</th>
              <th>File</th>
              <th className="col-actions" aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {certsQ.data?.map((c) => (
              <tr key={c.id}>
                <td>
                  <div className="data-row-name">{c.label}</div>
                </td>
                <td>
                  <span className="data-row-meta">{c.kind}</span>
                </td>
                <td>
                  <span className="data-row-platform">
                    <span className={`data-row-platform-icon is-${c.platform}`}>
                      {c.platform === "ios" ? <Apple size={12} /> : <Smartphone size={12} />}
                    </span>
                    <span>{c.platform === "ios" ? "iOS" : "Android"}</span>
                  </span>
                </td>
                <td>
                  <span className="data-row-meta is-truncate">{c.fileName}</span>
                </td>
                <td className="col-actions">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton variant="menu" aria-label="More actions">
                        <MoreVertical size={16} />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem disabled>Edit</DropdownMenuItem>
                      <DropdownMenuItem destructive onSelect={() => remove.mutate(c.id)}>
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {certsQ.data?.length === 0 && (
          <div className="empty-state">No certificates yet.</div>
        )}
      </div>
    </div>
  );
}

function AddCertDialog({
  orgId,
  platform,
  onClose,
}: {
  orgId: string;
  platform: Platform;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isIos = platform === "ios";
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [provisionFiles, setProvisionFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);

  const kind = isIos ? "p12" : "keystore";

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
        ? { provisionCount: String(provisionFiles.length) }
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
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <div>
            <DialogTitle>Add signing certificate</DialogTitle>
          </div>
        </DialogHeader>

        <div className="dialog-body">
          <div className="field-group">
            <Label htmlFor="cert-label">Name</Label>
            <Input
              id="cert-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={isIos ? "iOS Distribution" : "Production keystore"}
            />
          </div>

          <div className="card cert-platform-card">
            <div className="card-content">
              <div className="row" style={{ gap: 12 }}>
                <span className={`svc-icon is-${platform}`} aria-hidden style={{ width: 32, height: 32 }}>
                  {isIos ? <Apple size={16} /> : <Smartphone size={16} />}
                </span>
                <div>
                  <div className="data-row-name">{isIos ? "iOS" : "Android"}</div>
                  <div className="data-row-meta">
                    Credentials for signing {isIos ? "iOS" : "Android"} apps.{" "}
                    <a className="link" href="#" onClick={(e) => e.preventDefault()}>
                      View docs
                    </a>
                  </div>
                </div>
              </div>

              <div className="field-group">
                <Label className="is-small">
                  {isIos ? "App development / Store certificate" : "Keystore (.jks / .keystore)"}
                </Label>
                <FileDrop
                  accept={isIos ? ".p12,.cer" : ".jks,.keystore"}
                  value={file}
                  onChange={(files) => setFile(files[0] ?? null)}
                  hint={
                    <>
                      Drop file here or <span className="filedrop-link">browse</span>
                    </>
                  }
                />
              </div>

              {isIos && (
                <div className="field-group">
                  <Label className="is-small">Provisioning profiles</Label>
                  <p className="text-help">
                    Upload the profile for your main app. Optionally include additional profiles if
                    you are building app extensions.
                  </p>
                  <FileDrop
                    accept=".mobileprovision"
                    multiple
                    value={provisionFiles}
                    onChange={setProvisionFiles}
                    hint={
                      <>
                        Drop files here or <span className="filedrop-link">browse</span>
                      </>
                    }
                  />
                </div>
              )}

              <div className="field-group">
                <Label htmlFor="cert-pass" className="is-small">
                  {isIos ? "Certificate password" : "Keystore password"}
                </Label>
                <Input
                  id="cert-pass"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              {!isIos && (
                <div className="field-group">
                  <Label htmlFor="alias" className="is-small">Key alias</Label>
                  <Input
                    id="alias"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    placeholder="key0"
                  />
                </div>
              )}
            </div>
          </div>

          {error && <p className="text-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!file || !label.trim() || create.isPending}
            loading={create.isPending}
          >
            Add certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
