import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Upload } from "lucide-react";
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
  Label,
} from "@mobileflow/ui";
import { ApiError, api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";

const MAX_AVATAR_BYTES = 256 * 1024;

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

const PASSWORD_RULES = [
  { key: "length", label: "8–128 characters", test: (p: string) => p.length >= 8 && p.length <= 128 },
  { key: "special", label: "1 special character", test: (p: string) => /[^a-zA-Z0-9]/.test(p) },
  { key: "number", label: "1 number", test: (p: string) => /\d/.test(p) },
] as const;

export function PersonalAccountPage() {
  const { me, refresh } = useAuth();

  if (!me) return null;
  const hasPassword = me.user.hasPassword;

  return hasPassword ? (
    <PasswordUserAccount me={me} refresh={refresh} />
  ) : (
    <SsoUserAccount me={me} refresh={refresh} />
  );
}

// ---------- Password-user layout (full Basic info / Change password / Delete) ----------
function PasswordUserAccount({
  me,
  refresh,
}: {
  me: NonNullable<ReturnType<typeof useAuth>["me"]>;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [confirmPassword, setConfirmPassword] = useState("");
  const [basicError, setBasicError] = useState<string | null>(null);
  const [basicSuccess, setBasicSuccess] = useState(false);
  const [rejectedFile, setRejectedFile] = useState<File | null>(null);

  useEffect(() => {
    setName(me.user.name ?? "");
    setEmail(me.user.email);
    setUsername(me.user.username ?? "");
    setAvatarUrl(me.user.avatarUrl ?? null);
  }, [me.user.id, me.user.name, me.user.email, me.user.username, me.user.avatarUrl]);

  const basicDirty =
    name.trim() !== (me.user.name ?? "") ||
    email.trim() !== me.user.email ||
    username.trim() !== (me.user.username ?? "") ||
    (avatarUrl ?? null) !== (me.user.avatarUrl ?? null);

  const updateBasic = useMutation({
    mutationFn: () =>
      api.patchMe({
        name: name.trim() || null,
        email: email.trim(),
        username: username.trim() || null,
        avatarUrl: avatarUrl ?? null,
        currentPassword: confirmPassword,
      }),
    onSuccess: () => {
      setBasicSuccess(true);
      setConfirmPassword("");
      void refresh();
      setTimeout(() => setBasicSuccess(false), 2500);
    },
    onError: (err) => setBasicError(err instanceof ApiError ? err.message : "Update failed"),
  });

  function submitBasic(e: React.FormEvent) {
    e.preventDefault();
    setBasicError(null);
    setBasicSuccess(false);
    if (confirmPassword.length === 0) {
      setBasicError("Enter your password to confirm changes");
      return;
    }
    updateBasic.mutate();
  }

  async function handleAvatarFile(file: File) {
    setBasicError(null);
    if (!file.type.startsWith("image/")) {
      setBasicError("Please choose an image file");
      return;
    }
    try {
      const dataUrl = await resizeImageToDataUrl(file, 256);
      if (dataUrl.length > MAX_AVATAR_BYTES) {
        setBasicError("Avatar is too large. Please use a smaller image.");
        return;
      }
      setAvatarUrl(dataUrl);
    } catch {
      setBasicError("Could not read image");
    }
  }

  // ---- Change password ----
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordAgain, setNewPasswordAgain] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);

  const pwChecks = useMemo(
    () => PASSWORD_RULES.map((r) => ({ ...r, ok: r.test(newPassword) })),
    [newPassword],
  );
  const pwValid = pwChecks.every((c) => c.ok);
  const pwMatches = newPassword.length > 0 && newPassword === newPasswordAgain;

  const changePassword = useMutation({
    mutationFn: () => api.changePassword({ currentPassword, newPassword }),
    onSuccess: () => {
      setPwSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordAgain("");
      setTimeout(() => setPwSuccess(false), 2500);
    },
    onError: (err) => setPwError(err instanceof ApiError ? err.message : "Update failed"),
  });

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(false);
    if (!pwValid) {
      setPwError("New password doesn't meet the requirements");
      return;
    }
    if (!pwMatches) {
      setPwError("Passwords don't match");
      return;
    }
    changePassword.mutate();
  }

  const initial = (name.trim()[0] || me.user.email[0] || "?").toUpperCase();

  return (
    <div className="settings-page">
      {/* ---- Basic info ------------------------------------------------ */}
      <section className="settings-row">
        <div className="settings-row__label">
          <strong>Basic info</strong>
          <p className="settings-row__hint">
            Changing this information will also affect your name and appearance on all other
            MobileFlow websites.
          </p>
        </div>
        <form className="settings-row__content" onSubmit={submitBasic}>
          <div className="settings-field">
            <Label>User icon</Label>
            <ImageDrop
              className="user-icon-upload"
              ariaLabel="Change user avatar"
              onFile={(f) => void handleAvatarFile(f)}
              onReject={(f) => setRejectedFile(f)}
            >
              <div className="user-icon-tile" aria-hidden>
                {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{initial}</span>}
              </div>
              <span className="imagedrop__overlay" aria-hidden>
                <Upload size={18} />
              </span>
            </ImageDrop>
          </div>

          <div className="settings-field">
            <Label htmlFor="me-name">Name</Label>
            <Input id="me-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="settings-field">
            <Label htmlFor="me-email">Email</Label>
            <Input
              id="me-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="settings-field">
            <Label htmlFor="me-username">Username</Label>
            <Input
              id="me-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="janedoe"
            />
          </div>

          <p className="settings-confirm-hint">Confirm your password to make changes:</p>
          <div className="settings-field">
            <Label htmlFor="me-confirm">Password</Label>
            <Input
              id="me-confirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          {basicError && <p className="settings-page__error">{basicError}</p>}
          {basicSuccess && <p className="settings-page__success">Saved.</p>}

          <div>
            <Button
              type="submit"
              disabled={!basicDirty || updateBasic.isPending}
              loading={updateBasic.isPending}
            >
              Save
            </Button>
          </div>
        </form>
      </section>

      <hr className="settings-divider" />

      {/* ---- Change password ------------------------------------------ */}
      <section className="settings-row">
        <div className="settings-row__label">
          <strong>Change password</strong>
          <p className="settings-row__hint">Passwords must:</p>
          <ul className="password-rules password-rules--static">
            {PASSWORD_RULES.map((r) => (
              <li key={r.key}>{r.label}</li>
            ))}
          </ul>
        </div>
        <form className="settings-row__content" onSubmit={submitPassword}>
          <div className="settings-field">
            <Label htmlFor="cur-pw">Current Password</Label>
            <Input
              id="cur-pw"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>

          <div className="settings-field">
            <Label htmlFor="new-pw">New Password</Label>
            <Input
              id="new-pw"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          {newPassword.length > 0 && (
            <ul className="password-rules">
              {pwChecks.map((c) => (
                <li key={c.key} className={c.ok ? "is-ok" : ""}>
                  <span className="password-rules-check" aria-hidden>
                    {c.ok ? "✓" : ""}
                  </span>
                  {c.label}
                </li>
              ))}
            </ul>
          )}

          <div className="settings-field">
            <Label htmlFor="new-pw-again">New Password (again)</Label>
            <Input
              id="new-pw-again"
              type="password"
              value={newPasswordAgain}
              onChange={(e) => setNewPasswordAgain(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          {pwError && <p className="settings-page__error">{pwError}</p>}
          {pwSuccess && <p className="settings-page__success">Password updated.</p>}

          <div>
            <Button
              type="submit"
              disabled={
                changePassword.isPending ||
                currentPassword.length === 0 ||
                !pwValid ||
                !pwMatches
              }
              loading={changePassword.isPending}
            >
              Save
            </Button>
          </div>
        </form>
      </section>

      <hr className="settings-divider" />

      <DeleteAccountSection mode="password" userEmail={me.user.email} />

      <Dialog open={!!rejectedFile} onOpenChange={(open) => !open && setRejectedFile(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsupported image</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              <strong>{rejectedFile?.name ?? "That file"}</strong> isn't a supported image format.
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

// ---------- SSO-only user layout (Username / SSO credentials / Delete) ----------
function SsoUserAccount({
  me,
  refresh,
}: {
  me: NonNullable<ReturnType<typeof useAuth>["me"]>;
  refresh: () => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setUsername(me.user.username ?? "");
  }, [me.user.id, me.user.username]);

  const dirty = username.trim() !== (me.user.username ?? "");

  const update = useMutation({
    mutationFn: () => api.patchMe({ username: username.trim() || null }),
    onSuccess: () => {
      setSuccess(true);
      void refresh();
      setTimeout(() => setSuccess(false), 2500);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Update failed"),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    update.mutate();
  }

  return (
    <div className="settings-page">
      {/* ---- Username -------------------------------------------------- */}
      <section className="settings-row">
        <div className="settings-row__label">
          <strong>Username</strong>
          <p className="settings-row__hint">
            Changing your username will also affect your name and appearance on all other
            MobileFlow websites.
          </p>
        </div>
        <form className="settings-row__content" onSubmit={submit}>
          <div className="settings-field">
            <Label htmlFor="me-username">Username</Label>
            <Input
              id="me-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="janedoe"
            />
          </div>

          {error && <p className="settings-page__error">{error}</p>}
          {success && <p className="settings-page__success">Saved.</p>}

          <div>
            <Button type="submit" disabled={!dirty || update.isPending} loading={update.isPending}>
              Save
            </Button>
          </div>
        </form>
      </section>

      <hr className="settings-divider" />

      {/* ---- Single sign-on credentials -------------------------------- */}
      <section className="settings-row">
        <div className="settings-row__label">
          <strong>Single sign-on credentials</strong>
          <p className="settings-row__hint">
            Your SSO credentials are controlled by your single sign-on provider. Please contact
            your SSO administrator if you'd like to make changes.
          </p>
        </div>
        <div className="settings-row__content">
          <div className="settings-field">
            <Label htmlFor="me-sso-email">Email</Label>
            <Input id="me-sso-email" type="email" value={me.user.email} readOnly disabled />
          </div>
        </div>
      </section>

      <hr className="settings-divider" />

      <DeleteAccountSection mode="email" userEmail={me.user.email} />
    </div>
  );
}

// ---------- Shared delete section + dialog ----------
function DeleteAccountSection({
  mode,
  userEmail,
}: {
  mode: "password" | "email";
  userEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const deleteAccount = useMutation({
    mutationFn: () =>
      mode === "password"
        ? api.deleteMe({ password })
        : api.deleteMe({ email: emailInput.trim() }),
    onSuccess: () => {
      window.location.replace("/login");
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Delete failed"),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "password") {
      if (password.length === 0) {
        setError("Enter your password to confirm");
        return;
      }
    } else {
      if (emailInput.trim().toLowerCase() !== userEmail.toLowerCase()) {
        setError("Email does not match your account");
        return;
      }
    }
    deleteAccount.mutate();
  }

  const confirmDisabled =
    deleteAccount.isPending ||
    (mode === "password"
      ? password.length === 0
      : emailInput.trim().toLowerCase() !== userEmail.toLowerCase());

  return (
    <>
      <section className="settings-row">
        <div className="settings-row__label">
          <strong>Delete account</strong>
          <p className="settings-row__hint">
            If you delete your MobileFlow account, your data and access to organizations will be
            gone forever.
          </p>
        </div>
        <div className="settings-row__content">
          <Button
            variant="outline"
            className="btn-danger-outline"
            onClick={() => {
              setPassword("");
              setEmailInput("");
              setError(null);
              setOpen(true);
            }}
          >
            Delete My Account
          </Button>
        </div>
      </section>

      <hr className="settings-divider" />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close and Delete Account</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription asChild>
              <div>
                <p className="dialog-emphasis">
                  Are you sure you want to close and delete your account?
                </p>
                <p>
                  This action is irreversible.{" "}
                  {mode === "password"
                    ? "Enter your password to confirm you want to permanently close and delete this account:"
                    : "Type your email address to confirm you want to permanently close and delete this account:"}
                </p>
              </div>
            </DialogDescription>
            <form onSubmit={submit} className="settings-field" style={{ marginTop: "var(--space-md)" }}>
              {mode === "password" ? (
                <Input
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              ) : (
                <Input
                  type="email"
                  placeholder={userEmail}
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  autoComplete="off"
                />
              )}
              {error && <p className="settings-page__error">{error}</p>}
            </form>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={(e) => submit(e as unknown as React.FormEvent)}
              disabled={confirmDisabled}
              loading={deleteAccount.isPending}
            >
              Close and delete this account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
