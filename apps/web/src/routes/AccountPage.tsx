import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, Copy, Upload } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  ImageDrop,
  Input,
} from "@mobileflow/ui";
import { ApiError, api, type OrgRow } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { FieldError } from "../components/FieldError";

const MAX_ICON_BYTES = 256 * 1024;
// Validation limits — mirror apps/api/src/routes/orgs.ts.
const ORG_NAME_MAX = 120;
const ORG_DESCRIPTION_MAX = 500;
const ORG_BILLING_EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AccountPage() {
  const { orgId } = useParams();
  const qc = useQueryClient();
  const { me, refresh } = useAuth();

  const orgQ = useQuery({
    queryKey: ["org", orgId],
    queryFn: () => api.getOrg(orgId!),
    enabled: !!orgId,
  });
  const org = orgQ.data;

  const [name, setName] = useState("");
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [billingEmail, setBillingEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rejectedFile, setRejectedFile] = useState<File | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (org) {
      // Pre-populate the org name from the row when set, otherwise fall back
      // to the signed-in user's name (and finally email local-part) so the
      // field isn't blank on first visit for orgs created with no explicit
      // name. Users can override this and Save like any other edit.
      const fallback =
        me?.user.name?.trim() ||
        (me?.user.email ? me.user.email.split("@")[0]! : "");
      setName(org.name || fallback);
      setIconUrl(org.iconUrl);
      setDescription(org.description ?? "");
      setBillingEmail(org.billingEmail ?? "");
    }
  }, [org?.id, org?.name, org?.iconUrl, org?.description, org?.billingEmail, me?.user.name, me?.user.email]);

  // Per-field validation — mirrors the backend zod schema so the user gets
  // the same answer locally that the server would return on submit.
  const nameError = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed) return "Organization name is required";
    if (trimmed.length > ORG_NAME_MAX) return `Organization name must be ${ORG_NAME_MAX} characters or fewer`;
    return null;
  }, [name]);

  const descriptionError = useMemo(() => {
    if (description.trim().length > ORG_DESCRIPTION_MAX) {
      return `Description must be ${ORG_DESCRIPTION_MAX} characters or fewer`;
    }
    return null;
  }, [description]);

  const billingEmailError = useMemo(() => {
    const trimmed = billingEmail.trim();
    // Billing email is optional. Only validate format when the user typed
    // something — empty means "no billing email", not an error.
    if (!trimmed) return null;
    if (trimmed.length > ORG_BILLING_EMAIL_MAX) {
      return `Billing email must be ${ORG_BILLING_EMAIL_MAX} characters or fewer`;
    }
    if (!EMAIL_RE.test(trimmed)) return "Enter a valid email address";
    return null;
  }, [billingEmail]);

  const hasErrors = !!nameError || !!descriptionError || !!billingEmailError;
  const dirty =
    !!org &&
    (name.trim() !== org.name ||
      (iconUrl ?? null) !== (org.iconUrl ?? null) ||
      (description.trim() || null) !== (org.description ?? null) ||
      (billingEmail.trim() || null) !== (org.billingEmail ?? null));

  const update = useMutation({
    mutationFn: () =>
      api.patchOrg(orgId!, {
        name: name.trim(),
        iconUrl: iconUrl ?? null,
        description: description.trim() || null,
        billingEmail: billingEmail.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org", orgId] });
      void refresh();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Update failed"),
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

  function copyOrgId() {
    if (!org) return;
    void navigator.clipboard.writeText(org.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (orgQ.isLoading) return <p className="settings-page__status">Loading…</p>;
  if (orgQ.error)
    return <p className="settings-page__status is-danger">{(orgQ.error as ApiError).message}</p>;
  if (!org) return null;

  return (
    <div className="settings-page">
      <h1 className="page-title">{org.name} Settings</h1>

      <section className="settings-row">
        <div className="settings-row__label">Basic information</div>
        <div className="settings-row__content">
          <div className="settings-field">
            <label className="settings-field__label">Organization icon</label>
            <ImageDrop
              className="settings-icon-upload"
              ariaLabel="Change organization icon"
              onFile={(f) => void handleFile(f)}
              onReject={(f) => setRejectedFile(f)}
            >
              <OrgIconPreview org={org} overrideUrl={iconUrl} />
              <span className="imagedrop__overlay" aria-hidden>
                <Upload size={18} />
              </span>
            </ImageDrop>
          </div>

          <div className="settings-field">
            <label className="settings-field__label" htmlFor="org-name">
              Organization name
            </label>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={ORG_NAME_MAX}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "org-name-error" : undefined}
            />
            {nameError && <FieldError id="org-name-error">{nameError}</FieldError>}
          </div>

          <div className="settings-field">
            <label className="settings-field__label" htmlFor="org-description">
              Description
            </label>
            <Input
              id="org-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={ORG_DESCRIPTION_MAX}
              aria-invalid={descriptionError ? true : undefined}
              aria-describedby={descriptionError ? "org-description-error" : undefined}
            />
            {descriptionError && (
              <FieldError id="org-description-error">{descriptionError}</FieldError>
            )}
          </div>

          <div className="settings-field">
            <label className="settings-field__label" htmlFor="org-billing-email">
              Billing email
            </label>
            <Input
              id="org-billing-email"
              type="email"
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
              maxLength={ORG_BILLING_EMAIL_MAX}
              aria-invalid={billingEmailError ? true : undefined}
              aria-describedby={billingEmailError ? "org-billing-email-error" : undefined}
            />
            {billingEmailError && (
              <FieldError id="org-billing-email-error">{billingEmailError}</FieldError>
            )}
          </div>

          <div>
            <Button
              onClick={() => update.mutate()}
              disabled={!dirty || hasErrors || update.isPending}
              loading={update.isPending}
            >
              Save settings
            </Button>
          </div>
        </div>
      </section>

      <hr className="settings-divider" />

      <section className="settings-row">
        <div className="settings-row__label">Organization ID</div>
        <div className="settings-row__content">
          <div className="org-id-display">
            <code className="org-id-display__value">{org.id}</code>
            <IconButton
              variant="menu"
              aria-label={copied ? "Copied" : "Copy organization ID"}
              onClick={copyOrgId}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          </div>
        </div>
      </section>

      <hr className="settings-divider" />

      <section className="settings-row">
        <div className="settings-row__label">Transfer ownership</div>
        <div className="settings-row__content">
          <p className="settings-transfer__copy">
            To transfer ownership of this organization to a different member, please contact
            support at <a className="link" href="mailto:help@mobileflow.com">help@mobileflow.com</a>.
          </p>
        </div>
      </section>

      {error && <p className="settings-page__error">{error}</p>}

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
              <strong>{rejectedFile?.name ?? "That file"}</strong> isn’t a supported image format.
              Please choose a JPG, PNG, GIF, WEBP, or BMP file.
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

function OrgIconPreview({
  org,
  overrideUrl,
}: {
  org: OrgRow;
  overrideUrl?: string | null;
}) {
  const url = overrideUrl !== undefined ? overrideUrl : org.iconUrl;
  if (url) {
    return <img src={url} alt="" className="settings-icon settings-icon--img" />;
  }
  return (
    <div className="settings-icon settings-icon--org" aria-hidden="true">
      <Building2 size={28} />
    </div>
  );
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
