import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APP_NAME, LEGAL_NAME } from "@mobileflow/shared";
import { Button, Input, Label, Loading, cn } from "@mobileflow/ui";
import { Upload, Trash2 } from "lucide-react";
import { ApiError, api } from "../api/client";

const ACCEPTED_ATTR = "image/png,image/jpeg";
const MAX_BYTES = 2 * 1024 * 1024;
const LOGO_UPLOAD_MIMES = new Set(["image/png", "image/jpeg"]);

export function AdminCompanyPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "company-info"],
    queryFn: () => api.admin.getCompanyInfo(),
  });

  const [form, setForm] = useState<{
    name: string;
    legalName: string;
    supportEmail: string;
    salesEmail: string;
  }>({ name: "", legalName: "", supportEmail: "", salesEmail: "" });
  const [error, setError] = useState<string | null>(null);

  // Hydrate the form from the loaded row. Subsequent server updates also
  // bounce through here so the page never drifts from the canonical state.
  useEffect(() => {
    if (q.data) {
      setForm({
        name: q.data.name ?? "",
        legalName: q.data.legalName ?? "",
        supportEmail: q.data.supportEmail ?? "",
        salesEmail: q.data.salesEmail ?? "",
      });
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: () =>
      api.admin.putCompanyInfo({
        name: form.name.trim() || null,
        legalName: form.legalName.trim() || null,
        supportEmail: form.supportEmail.trim() || null,
        salesEmail: form.salesEmail.trim() || null,
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["admin", "company-info"] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Company</h1>
      </div>
      <p className="text-help">
        Branding shown on invoices, receipts, and (later) transactional emails.
      </p>

      <div className="page-section stack-md">
        <LogoDropzone existingMime={q.data?.logoMime ?? null} />

        <fieldset className="billing-address-group">
          <legend className="billing-address-group__legend">Identity</legend>
          <div className="settings-field">
            <Label className="is-small">Display name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder={APP_NAME}
            />
            <p className="text-help">Shown above the invoice address block.</p>
          </div>
          <div className="settings-field">
            <Label className="is-small">Legal / company name</Label>
            <Input
              value={form.legalName}
              onChange={(e) => setForm((s) => ({ ...s, legalName: e.target.value }))}
              placeholder={LEGAL_NAME}
            />
          </div>
          <div className="row gap-md">
            <div className="settings-field grow">
              <Label className="is-small">Support email</Label>
              <Input
                type="email"
                value={form.supportEmail}
                onChange={(e) =>
                  setForm((s) => ({ ...s, supportEmail: e.target.value }))
                }
                placeholder="support@mobileflow.dev"
              />
            </div>
            <div className="settings-field grow">
              <Label className="is-small">Sales email</Label>
              <Input
                type="email"
                value={form.salesEmail}
                onChange={(e) =>
                  setForm((s) => ({ ...s, salesEmail: e.target.value }))
                }
                placeholder="sales@mobileflow.dev"
              />
            </div>
          </div>
        </fieldset>

        {error && <p className="text-error">{error}</p>}

        <div className="row-end">
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Logo dropzone ───────────────────────────────────────────────────────────

function LogoDropzone({ existingMime }: { existingMime: string | null }) {
  const qc = useQueryClient();
  const [dragging, setDragging] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tick gets bumped on every save/delete so the existing-logo <img> URL is
  // unique and the browser re-fetches instead of serving a cached version.
  const [tick, setTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({
    mutationFn: (args: { mime: string; base64: string }) =>
      api.admin.putCompanyLogo(args),
    onSuccess: () => {
      setError(null);
      setPreviewSrc(null);
      setTick((t) => t + 1);
      qc.invalidateQueries({ queryKey: ["admin", "company-info"] });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : (err as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.admin.deleteCompanyLogo(),
    onSuccess: () => {
      setError(null);
      setPreviewSrc(null);
      setTick((t) => t + 1);
      qc.invalidateQueries({ queryKey: ["admin", "company-info"] });
    },
  });

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      if (!LOGO_UPLOAD_MIMES.has(file.type)) {
        setError("Unsupported file type. Choose a PNG or JPG image.");
        return;
      }
      try {
        const pngDataUrl = await rasterizeImageToPngDataUrl(file);
        const base64 = pngDataUrl.replace(/^data:[^;]+;base64,/, "");
        const bytes = Math.floor((base64.length * 3) / 4);
        if (bytes > MAX_BYTES) {
          setError(`File too large (${Math.round(bytes / 1024)} KB). Limit 2 MB.`);
          return;
        }
        setPreviewSrc(pngDataUrl);
        upload.mutate({ mime: "image/png", base64 });
      } catch {
        setError("Could not read image");
      }
    },
    [upload],
  );

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  const hasLogo = !!existingMime;

  return (
    <fieldset className="billing-address-group">
      <legend className="billing-address-group__legend">Logo</legend>

      <div
        className={cn("logo-dropzone", dragging && "is-dragging")}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileRef.current?.click();
          }
        }}
      >
        {previewSrc || hasLogo ? (
          <img
            className="logo-dropzone__preview"
            src={previewSrc ?? `${api.admin.companyLogoUrl()}?v=${tick}`}
            alt="Company logo"
          />
        ) : (
          <div className="logo-dropzone__empty">
            <Upload size={18} aria-hidden />
            <span>
              Drag & drop a logo here or click to browse
              <br />
              <span className="text-help">PNG or JPG only · converted to PNG · up to 2 MB</span>
            </span>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={ACCEPTED_ATTR}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            // Reset so picking the same file again re-fires onChange.
            e.target.value = "";
          }}
        />
      </div>

      {hasLogo && (
        <div className="row" style={{ marginTop: 8 }}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            <Trash2 size={13} aria-hidden /> Remove logo
          </Button>
        </div>
      )}

      {upload.isPending && (
        <p className="text-help">
          <Loading>Uploading…</Loading>
        </p>
      )}
      {error && <p className="text-error">{error}</p>}
    </fieldset>
  );
}

async function rasterizeImageToPngDataUrl(file: File): Promise<string> {
  const reader = new FileReader();
  const source = await new Promise<string>((resolve, reject) => {
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = source;
  });

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}
