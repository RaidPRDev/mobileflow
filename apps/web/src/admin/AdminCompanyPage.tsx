import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Label, cn } from "@mobileflow/ui";
import { Upload, Trash2 } from "lucide-react";
import { ApiError, api, type CompanyInfo } from "../api/client";

const ACCEPTED_MIMES = ["image/png", "image/jpeg", "image/svg+xml"] as const;
const ACCEPTED_ATTR = ACCEPTED_MIMES.join(",");
const MAX_BYTES = 2 * 1024 * 1024;

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
              placeholder="MobileFlow"
            />
            <p className="text-help">Shown above the invoice address block.</p>
          </div>
          <div className="settings-field">
            <Label className="is-small">Legal / company name</Label>
            <Input
              value={form.legalName}
              onChange={(e) => setForm((s) => ({ ...s, legalName: e.target.value }))}
              placeholder="MobileFlow, Inc."
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
    (file: File) => {
      setError(null);
      if (!ACCEPTED_MIMES.includes(file.type as (typeof ACCEPTED_MIMES)[number])) {
        setError("Unsupported file type. Use PNG, JPG, or SVG.");
        return;
      }
      if (file.size > MAX_BYTES) {
        setError(`File too large (${Math.round(file.size / 1024)} KB). Limit 2 MB.`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") return;
        // result is a `data:<mime>;base64,<payload>` URL.
        setPreviewSrc(result);
        const base64 = result.replace(/^data:[^;]+;base64,/, "");
        upload.mutate({ mime: file.type, base64 });
      };
      reader.readAsDataURL(file);
    },
    [upload],
  );

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
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
              <span className="text-help">PNG, JPG, or SVG · up to 2 MB</span>
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
            if (file) handleFile(file);
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

      {upload.isPending && <p className="text-help">Uploading…</p>}
      {error && <p className="text-error">{error}</p>}
    </fieldset>
  );
}
