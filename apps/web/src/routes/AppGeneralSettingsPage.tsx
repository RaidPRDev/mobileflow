import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ImageDrop,
  Input,
  Switch,
} from "@mobileflow/ui";
import { Info, Upload } from "lucide-react";
import { RUNTIME_LABEL } from "@mobileflow/shared";
import { ApiError, api, type AppRow } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { relativeTime } from "../lib/dates";

const MAX_ICON_BYTES = 256 * 1024; // 256 KB encoded data URL

export function AppGeneralSettingsPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();

  const appQ = useQuery({
    queryKey: ["app", appId],
    queryFn: () => api.getApp(appId!),
    enabled: !!appId,
  });
  const app = appQ.data;

  const [name, setName] = useState<string>("");
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleteAck, setDeleteAck] = useState(false);
  const [targetOrgId, setTargetOrgId] = useState("");
  const [rejectedFile, setRejectedFile] = useState<File | null>(null);

  useEffect(() => {
    if (app) {
      setName(app.name);
      setIconUrl(app.iconUrl);
    }
  }, [app?.id, app?.name, app?.iconUrl]);

  const dirty =
    !!app && (name.trim() !== app.name || (iconUrl ?? null) !== (app.iconUrl ?? null));
  const nameValid = name.trim().length > 0;

  const update = useMutation({
    mutationFn: () =>
      api.patchApp(appId!, {
        name: name.trim(),
        iconUrl: iconUrl ?? null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app", appId] });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Update failed"),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteApp(appId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps"] });
      navigate(`/org/${app!.orgId}/apps`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Delete failed"),
  });

  const transfer = useMutation({
    mutationFn: () => api.transferApp(appId!, targetOrgId.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app", appId] });
      qc.invalidateQueries({ queryKey: ["apps"] });
      setTargetOrgId("");
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Transfer failed"),
  });

  async function handleFile(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file");
      return;
    }
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256);
      if (dataUrl.length > MAX_ICON_BYTES) {
        setError("Icon is too large. Please use a smaller image.");
        return;
      }
      setIconUrl(dataUrl);
    } catch {
      setError("Could not read image");
    }
  }

  if (appQ.isLoading) return <p className="settings-page__status">Loading…</p>;
  if (appQ.error)
    return <p className="settings-page__status is-danger">{(appQ.error as ApiError).message}</p>;
  if (!app) return null;

  const otherOrgs = (me?.organizations ?? []).filter((o) => o.orgId !== app.orgId);

  return (
    <div className="settings-page">
      <div className="settings-page__breadcrumb">
        <span>Settings</span>
        <span className="settings-page__sep">/</span>
        <span className="settings-page__crumb-current">General</span>
      </div>
      <h1 className="page-title">General Settings</h1>

      <section className="settings-row">
        <div className="settings-row__label">App details</div>
        <div className="settings-row__content">
          <div className="settings-field">
            <label className="settings-field__label">App icon</label>
            <ImageDrop
              className="settings-icon-upload"
              ariaLabel="Change app icon"
              onFile={(f) => void handleFile(f)}
              onReject={(f) => setRejectedFile(f)}
            >
              <AppIconPreview app={app} overrideUrl={iconUrl} />
              <span className="imagedrop__overlay" aria-hidden>
                <Upload size={18} />
              </span>
            </ImageDrop>
          </div>

          <div className="settings-field">
            <label className="settings-field__label" htmlFor="general-app-name">
              App name
            </label>
            <Input
              id="general-app-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <Button
              onClick={() => update.mutate()}
              disabled={!dirty || !nameValid || update.isPending}
              loading={update.isPending}
            >
              Update
            </Button>
          </div>
        </div>
      </section>

      <hr className="settings-divider" />

      <section className="settings-row">
        <div className="settings-row__label">Delete app</div>
        <div className="settings-row__content">
          <div>
            <Button
              variant="outline"
              className="btn-danger-outline"
              onClick={() => setShowDelete(true)}
            >
              Delete App
            </Button>
          </div>
        </div>
      </section>

      <hr className="settings-divider" />

      <section className="settings-row">
        <div className="settings-row__label">Transfer ownership</div>
        <div className="settings-row__content">
          <p className="settings-transfer__copy">
            If you transfer ownership of this app to another account, you will no longer be the
            owner, but will be added as a collaborator of the app instead. This will give the new
            owner full control of the app, which means they can remove your access to the app.
          </p>
          <p className="settings-transfer__copy">
            To transfer ownership, enter the organization ID you wish to transfer ownership to:
          </p>
          <div className="settings-field">
            <label className="settings-field__label" htmlFor="transfer-org-id">
              Organization ID
              <span className="settings-field__hint" title="Find the ID under that org's Account page">
                <Info size={12} />
              </span>
            </label>
            <Input
              id="transfer-org-id"
              value={targetOrgId}
              onChange={(e) => setTargetOrgId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
            {otherOrgs.length > 0 && (
              <div className="settings-transfer__suggestions">
                {otherOrgs.map((o) => (
                  <button
                    key={o.orgId}
                    type="button"
                    className="settings-transfer__chip"
                    onClick={() => setTargetOrgId(o.orgId)}
                  >
                    {o.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <Button
              onClick={() => transfer.mutate()}
              disabled={!targetOrgId.trim() || transfer.isPending}
              loading={transfer.isPending}
            >
              Transfer app
            </Button>
          </div>
        </div>
      </section>

      {error && <p className="settings-page__error">{error}</p>}

      <Dialog
        open={showDelete}
        onOpenChange={(open) => {
          if (!open) {
            setShowDelete(false);
            setDeleteAck(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete app</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="delete-app-summary">
              <AppIconPreview app={app} overrideUrl={iconUrl} small />
              <div>
                <div className="delete-app-summary__name">{app.name}</div>
                <div className="delete-app-summary__meta">
                  {RUNTIME_LABEL[app.runtime] ?? app.runtime}
                  <span className="settings-page__sep">·</span>
                  {app.id.slice(0, 8)}
                  <span className="settings-page__sep">·</span>
                  Last updated {relativeTime(app.createdAt)}
                </div>
              </div>
            </div>
            <DialogDescription>Consider the following items before proceeding:</DialogDescription>
            <ul className="delete-app-list with-bullets">
              <li>All shared links, channels, and previews will be inaccessible</li>
              <li>All feedback, comments, and activity history will be destroyed</li>
              <li>All code, builds, and deploys will be deleted</li>
              <li>This action cannot be undone</li>
            </ul>
            <div className="delete-app-confirm">
              <Switch
                id="delete-app-ack"
                checked={deleteAck}
                onCheckedChange={setDeleteAck}
              />
              <span
                className="delete-app-confirm__text"
                onClick={() => setDeleteAck(!deleteAck)}
              >
                I understand and wish to continue
              </span>
            </div>
            {remove.error && (
              <p className="settings-page__error">{(remove.error as ApiError).message}</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDelete(false);
                setDeleteAck(false);
              }}
              disabled={remove.isPending}
            >
              Nevermind
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={!deleteAck || remove.isPending}
              loading={remove.isPending}
            >
              Delete app
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!rejectedFile}
        onOpenChange={(open) => !open && setRejectedFile(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsupported image</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              <strong>{rejectedFile?.name ?? "That file"}</strong> isn’t a supported image
              format. Please choose a JPG, PNG, GIF, WEBP, or BMP file.
            </DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setRejectedFile(null)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AppIconPreview({
  app,
  overrideUrl,
  small,
}: {
  app: AppRow;
  overrideUrl?: string | null;
  small?: boolean;
}) {
  const url = overrideUrl !== undefined ? overrideUrl : app.iconUrl;
  const className = small ? "settings-icon settings-icon--sm" : "settings-icon";
  const seed = useMemo(() => iconSeed(app), [app.id, app.name]);
  if (url) {
    return <img src={url} alt="" className={`${className} ${className}--img`} />;
  }
  const style = {
    background: `linear-gradient(135deg, hsl(${seed.hue}, 70%, 78%) 0%, hsl(${(seed.hue + 30) % 360}, 65%, 60%) 100%)`,
  };
  return (
    <div className={className} style={style} aria-hidden="true">
      <span className="settings-icon__letter">{seed.letter}</span>
    </div>
  );
}

function iconSeed(app: AppRow) {
  const seed = app.id || app.name;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return {
    hue: h % 360,
    letter: (app.name.trim()[0] ?? "?").toUpperCase(),
  };
}

async function resizeImageToDataUrl(file: File, size: number): Promise<string> {
  const reader = new FileReader();
  const readAsDataUrl = new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
  const src = await readAsDataUrl;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const scale = Math.min(1, size / Math.max(w, h));
  const tw = Math.round(w * scale);
  const th = Math.round(h * scale);
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0, tw, th);
  return canvas.toDataURL("image/png");
}
