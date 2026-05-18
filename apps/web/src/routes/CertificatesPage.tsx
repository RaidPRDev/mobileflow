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
import { ApiError, api, type CertificateGroup, type CertificateRow } from "../api/client";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import deleteIcon from "../../../../assets/icons/delete-icon.svg";

type Platform = "ios" | "android";

const DOCS_URL: Record<Platform, string> = {
  ios: "https://ionicframework.com/docs/appflow/package/credentials#ios-credentials",
  android: "https://ionicframework.com/docs/appflow/package/credentials#android-credentials",
};

async function fileToBase64(f: File): Promise<string> {
  const buf = await f.arrayBuffer();
  return btoa(
    Array.from(new Uint8Array(buf))
      .map((b) => String.fromCharCode(b))
      .join(""),
  );
}

function formatExpiration(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function CertificatesPage() {
  const { appId } = useParams();
  const qc = useQueryClient();

  const certsQ = useQuery({
    queryKey: ["certs", appId],
    queryFn: () => api.listCertificates(appId!),
    enabled: !!appId,
  });

  const [openPlatform, setOpenPlatform] = useState<Platform | null>(null);
  const [editingCert, setEditingCert] = useState<CertificateGroup | null>(null);
  const [deletingCert, setDeletingCert] = useState<CertificateGroup | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCertificate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["certs", appId] });
      setDeletingCert(null);
    },
  });

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

      {openPlatform && appId && (
        <AddCertDialog
          appId={appId}
          platform={openPlatform}
          onClose={() => setOpenPlatform(null)}
        />
      )}

      {editingCert && appId && (
        <EditCertDialog cert={editingCert} appId={appId} onClose={() => setEditingCert(null)} />
      )}

      {certsQ.isLoading && <p className="text-help">Loading…</p>}
      {certsQ.error && <p className="text-error">{(certsQ.error as ApiError).message}</p>}

      {!!certsQ.data?.length && (
        <div className="data-grid certs-table" role="table">
          <div className="data-grid__head" role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Platform</span>
            <span role="columnheader">Expiration Date</span>
            <span role="columnheader" aria-label="Actions"></span>
          </div>
          {certsQ.data.map((c) => (
            <div key={c.id} className="data-grid__row certs-row" role="row">
              <div role="cell">
                <div className="cell-stack">
                  <div className="data-row-name">{c.label}</div>
                  {c.provisioningProfiles.length > 0 && (
                    <div className="data-row-meta">
                      {c.provisioningProfiles.length} provisioning profile
                      {c.provisioningProfiles.length === 1 ? "" : "s"}
                    </div>
                  )}
                </div>
              </div>
              <div role="cell">
                <span className="data-row-meta">{c.kind}</span>
              </div>
              <div role="cell">
                <span className="data-row-platform">
                  <span className={`data-row-platform-icon is-${c.platform}`}>
                    {c.platform === "ios" ? <Apple size={12} /> : <Smartphone size={12} />}
                  </span>
                  <span>{c.platform === "ios" ? "iOS" : "Android"}</span>
                </span>
              </div>
              <div role="cell">
                <span className="data-row-meta">{formatExpiration(c.metadata?.expirationDate)}</span>
              </div>
              <div role="cell" className="data-grid__actions">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton variant="menu" aria-label="More actions">
                      <MoreVertical size={16} />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem onSelect={() => setEditingCert(c)}>
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem destructive onSelect={() => setDeletingCert(c)}>
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      )}
      {certsQ.data?.length === 0 && (
        <div className="empty-state">
          <h2 className="empty-state__title">No certificates yet</h2>
          <p className="empty-state__body">Upload a keystore or .p12 to sign your builds.</p>
        </div>
      )}

      {deletingCert && (
        <ConfirmDeleteDialog
          title="Delete signing certificate"
          itemName={deletingCert.label}
          details={buildCertDeleteDetails(deletingCert)}
          error={remove.error}
          pending={remove.isPending}
          onCancel={() => {
            if (!remove.isPending) {
              setDeletingCert(null);
              remove.reset();
            }
          }}
          onConfirm={() => remove.mutate(deletingCert.id)}
          confirmLabel="Delete certificate"
        />
      )}
    </div>
  );
}

function buildCertDeleteDetails(c: CertificateGroup): string[] {
  // Spell out what cascades so the user understands the blast radius. The
  // backend wipes the encrypted blob + password + provisioning-profile rows;
  // builds that were signed with this cert keep their record but lose the
  // link (FK is ON DELETE SET NULL).
  const details: string[] = [];
  const kindLabel = c.kind === "p12" ? "iOS .p12 certificate" : c.kind === "keystore" ? "Android keystore" : "provisioning profile";
  details.push(`The encrypted ${kindLabel} file (${c.fileName}) and its password will be permanently destroyed`);
  if (c.provisioningProfiles.length > 0) {
    details.push(
      `${c.provisioningProfiles.length} provisioning profile${c.provisioningProfiles.length === 1 ? "" : "s"} attached to this certificate will be deleted along with their .mobileprovision files`,
    );
  }
  details.push("Past builds that used this certificate keep their history, but lose the link to it");
  details.push("In-flight (queued or running) builds using this certificate will block the delete — cancel them first");
  return details;
}

// Small inline ×-style button using the shared delete-icon.svg.
function FileDeleteButton({ onClick, ariaLabel }: { onClick: () => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      className="cert-file-delete"
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <img src={deleteIcon} alt="" aria-hidden />
    </button>
  );
}

function PlatformHeader({ platform }: { platform: Platform }) {
  const isIos = platform === "ios";
  return (
    <div className="row" style={{ gap: 12 }}>
      <span className={`svc-icon is-${platform}`} aria-hidden style={{ width: 32, height: 32 }}>
        {isIos ? <Apple size={16} /> : <Smartphone size={16} />}
      </span>
      <div>
        <div className="data-row-name">{isIos ? "iOS" : "Android"}</div>
        <div className="data-row-meta">
          Credentials for signing {isIos ? "iOS" : "Android"} apps.{" "}
          <a className="link" href={DOCS_URL[platform]} target="_blank" rel="noreferrer">
            View docs
          </a>
        </div>
      </div>
    </div>
  );
}

function AddCertDialog({
  appId,
  platform,
  onClose,
}: {
  appId: string;
  platform: Platform;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isIos = platform === "ios";
  const kind = isIos ? "p12" : "keystore";

  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [provisionFiles, setProvisionFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [alias, setAlias] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Both platforms require the main file. Android needs alias; iOS needs at
  // least one provisioning profile to be uploaded with the p12.
  const canSubmit =
    !!file &&
    label.trim() !== "" &&
    (!isIos ? alias.trim() !== "" : provisionFiles.length > 0);

  const create = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Select a certificate file");
      if (!isIos && !alias.trim()) throw new Error("Key alias is required");
      if (isIos && provisionFiles.length === 0) throw new Error("At least one provisioning profile is required");

      const parent = await api.createCertificate(appId, {
        platform,
        kind,
        label: label.trim(),
        fileName: file.name,
        fileBase64: await fileToBase64(file),
        password: password || undefined,
        metadata: isIos ? {} : { alias: alias.trim() },
      });

      if (isIos) {
        for (const profile of provisionFiles) {
          const provisionName = profile.name.replace(/\.mobileprovision$/i, "");
          await api.createCertificate(appId, {
            platform: "ios",
            kind: "provisioning",
            parentCertId: parent.id,
            label: provisionName,
            fileName: profile.name,
            fileBase64: await fileToBase64(profile),
            metadata: { provisionName },
          });
        }
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["certs", appId] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
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
              <PlatformHeader platform={platform} />

              <div className="field-group">
                <Label className="is-small">
                  {isIos ? "App development / Store certificate" : "Keystore (.jks / .keystore)"}
                </Label>
                {file ? (
                  <div className="cert-file-row">
                    <span className="cert-file-row__name">{file.name}</span>
                    <FileDeleteButton onClick={() => setFile(null)} ariaLabel="Remove file" />
                  </div>
                ) : (
                  <FileDrop
                    accept={isIos ? ".p12,.cer" : ".jks,.keystore"}
                    value={null}
                    onChange={(files) => setFile(files[0] ?? null)}
                    hint={<>Drop file here or <span className="filedrop-link">browse</span></>}
                  />
                )}
              </div>

              {isIos && (
                <div className="field-group">
                  <Label className="is-small">Provisioning profiles</Label>
                  <p className="text-help">
                    Upload the profile for your main app. Optionally include additional profiles if
                    you are building app extensions.
                  </p>
                  {provisionFiles.length > 0 && (
                    <div className="cert-file-list">
                      {provisionFiles.map((f, i) => (
                        <div key={`${f.name}-${i}`} className="cert-file-row">
                          <span className="cert-file-row__name">{f.name}</span>
                          <FileDeleteButton
                            onClick={() => setProvisionFiles(provisionFiles.filter((_, idx) => idx !== i))}
                            ariaLabel={`Remove ${f.name}`}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <FileDrop
                    accept=".mobileprovision"
                    multiple
                    value={null}
                    onChange={(files) => setProvisionFiles([...provisionFiles, ...files])}
                    hint={<>Drop files here or <span className="filedrop-link">browse</span></>}
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
                    required
                  />
                </div>
              )}
            </div>
          </div>

          {error && <p className="text-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!canSubmit || create.isPending}
            loading={create.isPending}
          >
            Add certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface EditState {
  // The user can delete the existing main file and upload a replacement.
  // mainFile === null && removedMain === false → keep existing
  // mainFile === File                          → replace existing on save
  // mainFile === null && removedMain === true  → no main file present (block submit)
  mainFile: File | null;
  removedMain: boolean;
}

function EditCertDialog({ cert, appId, onClose }: { cert: CertificateGroup; appId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const isIos = cert.platform === "ios";
  const isKeystore = cert.kind === "keystore";

  const [label, setLabel] = useState(cert.label);
  const [password, setPassword] = useState(""); // blank = keep existing
  const [alias, setAlias] = useState(cert.metadata?.alias ?? "");
  const [editState, setEditState] = useState<EditState>({ mainFile: null, removedMain: false });

  // Provisioning state: existing rows the user has not removed + newly dropped files.
  const [existingProfiles, setExistingProfiles] = useState<CertificateRow[]>(cert.provisioningProfiles);
  const [removedProfileIds, setRemovedProfileIds] = useState<string[]>([]);
  const [newProfiles, setNewProfiles] = useState<File[]>([]);

  const [error, setError] = useState<string | null>(null);

  // Compute whether all required fields are present.
  const hasMainFile = editState.removedMain ? editState.mainFile !== null : true;
  const totalProfiles = existingProfiles.length + newProfiles.length;
  const canSubmit =
    label.trim() !== "" &&
    hasMainFile &&
    (isKeystore ? alias.trim() !== "" : true) &&
    (isIos ? totalProfiles > 0 : true);

  const save = useMutation({
    mutationFn: async () => {
      if (!hasMainFile) throw new Error("A signing file is required");
      if (isKeystore && !alias.trim()) throw new Error("Key alias is required");
      if (isIos && totalProfiles === 0) throw new Error("At least one provisioning profile is required");

      // 1. PATCH the parent row (label, password, metadata, optionally file).
      const metadata: Record<string, string> = { ...(cert.metadata ?? {}) };
      if (isKeystore) metadata.alias = alias.trim();

      const patch: Parameters<typeof api.updateCertificate>[1] = {
        label: label.trim(),
        password: password ? password : undefined,
        metadata,
      };
      if (editState.mainFile) {
        patch.fileBase64 = await fileToBase64(editState.mainFile);
        patch.fileName = editState.mainFile.name;
      }
      await api.updateCertificate(cert.id, patch);

      // 2. Delete provisioning profiles the user removed.
      for (const id of removedProfileIds) {
        await api.deleteCertificate(id);
      }

      // 3. Upload any newly-added provisioning profiles, linked to this parent.
      for (const profile of newProfiles) {
        const provisionName = profile.name.replace(/\.mobileprovision$/i, "");
        await api.createCertificate(appId, {
          platform: "ios",
          kind: "provisioning",
          parentCertId: cert.id,
          label: provisionName,
          fileName: profile.name,
          fileBase64: await fileToBase64(profile),
          metadata: { provisionName },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["certs"] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div>
            <DialogTitle>Edit signing certificate</DialogTitle>
          </div>
        </DialogHeader>

        <div className="dialog-body">
          <div className="field-group">
            <Label htmlFor="edit-cert-label">Name</Label>
            <Input
              id="edit-cert-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="card cert-platform-card">
            <div className="card-content">
              <PlatformHeader platform={cert.platform} />

              <div className="field-group">
                <Label className="is-small">
                  {isIos ? "App development / Store certificate" : "Keystore (.jks / .keystore)"}
                </Label>
                {editState.removedMain && editState.mainFile === null ? (
                  <FileDrop
                    accept={isIos ? ".p12,.cer" : ".jks,.keystore"}
                    value={null}
                    onChange={(files) =>
                      setEditState({ mainFile: files[0] ?? null, removedMain: true })
                    }
                    hint={<>Drop replacement file here or <span className="filedrop-link">browse</span></>}
                  />
                ) : (
                  <div className="cert-file-block">
                    <div className="cert-file-row">
                      <span className="cert-file-row__name">
                        {editState.mainFile ? editState.mainFile.name : cert.fileName}
                      </span>
                      <FileDeleteButton
                        onClick={() => setEditState({ mainFile: null, removedMain: true })}
                        ariaLabel="Remove file"
                      />
                    </div>
                    {!editState.mainFile && cert.kind === "p12" && (
                      <CertMetaTable
                        rows={[
                          ["Name", cert.metadata?.commonName],
                          ["Creation date", formatExpiration(cert.metadata?.creationDate)],
                          ["Expiration date", formatExpiration(cert.metadata?.expirationDate)],
                        ]}
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="field-group">
                <Label htmlFor="edit-cert-pass" className="is-small">
                  {isIos ? "Certificate password" : "Keystore password"}
                </Label>
                <Input
                  id="edit-cert-pass"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave blank to keep current password"
                />
              </div>

              {isKeystore && (
                <div className="field-group">
                  <Label htmlFor="edit-alias" className="is-small">Key alias</Label>
                  <Input
                    id="edit-alias"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    placeholder="key0"
                    required
                  />
                </div>
              )}

              {isIos && (
                <div className="field-group">
                  <Label className="is-small">Provisioning profiles</Label>
                  <p className="text-help">
                    Upload the profile for your main app. Optionally include additional profiles if
                    you are building app extensions.
                  </p>
                  {(existingProfiles.length > 0 || newProfiles.length > 0) && (
                    <div className="cert-file-list">
                      {existingProfiles.map((p) => (
                        <div key={p.id} className="cert-file-block">
                          <div className="cert-file-row">
                            <span className="cert-file-row__name">{p.fileName}</span>
                            <FileDeleteButton
                              onClick={() => {
                                setExistingProfiles(existingProfiles.filter((x) => x.id !== p.id));
                                setRemovedProfileIds([...removedProfileIds, p.id]);
                              }}
                              ariaLabel={`Remove ${p.fileName}`}
                            />
                          </div>
                          {(p.metadata?.bundleId || p.metadata?.teamId || p.metadata?.expirationDate) && (
                            <CertMetaTable
                              rows={[
                                ["BundleID", p.metadata?.bundleId],
                                ["Team", p.metadata?.teamId],
                                ["Expiration", formatExpiration(p.metadata?.expirationDate)],
                              ]}
                            />
                          )}
                        </div>
                      ))}
                      {newProfiles.map((f, i) => (
                        <div key={`new-${f.name}-${i}`} className="cert-file-row">
                          <span className="cert-file-row__name">{f.name}</span>
                          <FileDeleteButton
                            onClick={() => setNewProfiles(newProfiles.filter((_, idx) => idx !== i))}
                            ariaLabel={`Remove ${f.name}`}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                  <FileDrop
                    accept=".mobileprovision"
                    multiple
                    value={null}
                    onChange={(files) => setNewProfiles([...newProfiles, ...files])}
                    hint={<>Drop files here or <span className="filedrop-link">browse</span></>}
                  />
                </div>
              )}
            </div>
          </div>

          {error && <p className="text-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!canSubmit || save.isPending}
            loading={save.isPending}
          >
            Update certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CertMetaTable({ rows }: { rows: ReadonlyArray<readonly [string, string | undefined | null]> }) {
  return (
    <dl className="cert-meta">
      {rows.map(([k, v]) => (
        <div className="cert-meta__row" key={k}>
          <dt className="cert-meta__key">{k}</dt>
          <dd className="cert-meta__val">{v && v.trim() ? v : "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
