import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FileDrop,
  Input,
  Label,
  RadioGroup,
  type ComboboxOption,
} from "@mobileflow/ui";
import appStoreIcon from "@assets/icons/app-store-icon.svg";
import googlePlayIcon from "@assets/icons/google-playstore-icon.svg";
import { ApiError, api, type DestinationRow } from "../api/client";

export type DestType = "app_store" | "play_store";

export const TYPE_LABEL: Record<DestType, string> = {
  app_store: "Apple App Store",
  play_store: "Google Play Store",
};

export const TYPE_PLATFORM: Record<DestType, "ios" | "android"> = {
  app_store: "ios",
  play_store: "android",
};

export const TYPE_ICON_SRC: Record<DestType, string> = {
  app_store: appStoreIcon,
  play_store: googlePlayIcon,
};

export function destIcon(type: DestType, size = 18) {
  return <img src={TYPE_ICON_SRC[type]} alt="" width={size} height={size} className="dest-icon" />;
}

const DEST_OPTIONS: ComboboxOption<DestType>[] = (Object.keys(TYPE_LABEL) as DestType[]).map(
  (t) => ({ value: t, label: TYPE_LABEL[t], icon: destIcon(t, 16) }),
);

const TRACK_OPTIONS: ComboboxOption<string>[] = [
  { value: "internal", label: "internal" },
  { value: "alpha", label: "alpha" },
  { value: "beta", label: "beta" },
  { value: "production", label: "production" },
];

type AppleAuthMode = "api_key" | "altool";
type AndroidArtifactKind = "aab" | "apk";

export function StoreDestinationDialog({
  appId,
  existing,
  onClose,
}: {
  appId: string;
  existing?: DestinationRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!existing;

  // Type isn't editable once a destination exists — switching app_store <→>
  // play_store would change which credentials apply. Default to existing or
  // app_store. Cast covers legacy DB values (testflight/play_internal): we
  // still let the user edit them, just under the closest current label.
  const initialType: DestType = existing?.type === "play_store" ? "play_store" : "app_store";
  const [type, setType] = useState<DestType>(initialType);
  const [name, setName] = useState(existing?.name ?? "");

  // Seed Apple fields from configSummary so an edit dialog round-trips the
  // non-secret values. Secrets stay blank; an empty submit preserves the
  // existing ones server-side.
  const appleSeed = existing?.configSummary && "authMode" in existing.configSummary ? existing.configSummary : null;
  const seedAuthMode: AppleAuthMode = appleSeed?.authMode === "api_key" ? "api_key" : "altool";
  const [appleAuthMode, setAppleAuthMode] = useState<AppleAuthMode>(seedAuthMode);
  const [appleId, setAppleId] = useState(appleSeed?.authMode === "altool" ? appleSeed.appleId : "");
  const [appSpecificPassword, setAppSpecificPassword] = useState("");
  const [appAppleId, setAppAppleId] = useState(
    appleSeed?.authMode === "altool" ? appleSeed.appAppleId : existing?.bundleId ?? "",
  );
  const [teamId, setTeamId] = useState(appleSeed?.authMode === "altool" ? appleSeed.teamId : "");
  const [issuerId, setIssuerId] = useState(appleSeed?.authMode === "api_key" ? appleSeed.issuerId : "");
  const [keyId, setKeyId] = useState(appleSeed?.authMode === "api_key" ? appleSeed.keyId : "");
  const [p8, setP8] = useState("");

  // Android fields
  const googleSeed = existing?.configSummary && "artifactKind" in existing.configSummary ? existing.configSummary : null;
  const [track, setTrack] = useState<string>(existing?.trackOrChannel ?? "internal");
  const [packageName, setPackageName] = useState(existing?.bundleId ?? "");
  const [artifactKind, setArtifactKind] = useState<AndroidArtifactKind>(googleSeed?.artifactKind ?? "aab");
  const [jsonKeyFile, setJsonKeyFile] = useState<File | null>(null);

  const [error, setError] = useState<string | null>(null);

  const readFileText = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error("Could not read file"));
      fr.onload = () => resolve(String(fr.result ?? ""));
      fr.readAsText(file);
    });

  const save = useMutation({
    mutationFn: async () => {
      if (type === "app_store") {
        const config =
          appleAuthMode === "api_key"
            ? { authMode: "api_key", issuerId, keyId, privateKeyP8: p8 }
            : { authMode: "altool", appleId, appSpecificPassword, appAppleId, teamId };
        if (isEdit && existing) {
          return api.updateDestination(existing.id, {
            name: name.trim(),
            bundleId: appAppleId.trim() || null,
            trackOrChannel: null,
            config,
          });
        }
        return api.createDestination(appId, {
          name: name.trim(),
          type: "app_store",
          bundleId: appAppleId.trim() || null,
          trackOrChannel: null,
          config,
        });
      } else {
        // For Google, only include serviceAccountJson when a new file was
        // chosen; the backend's mergeConfig preserves the existing key when
        // we omit it on edit.
        const serviceAccountJson = jsonKeyFile ? await readFileText(jsonKeyFile) : "";
        const config: Record<string, unknown> = { artifactKind };
        if (serviceAccountJson || !isEdit) config.serviceAccountJson = serviceAccountJson;
        if (isEdit && existing) {
          return api.updateDestination(existing.id, {
            name: name.trim(),
            bundleId: packageName.trim() || null,
            trackOrChannel: track,
            config,
          });
        }
        return api.createDestination(appId, {
          name: name.trim(),
          type: "play_store",
          bundleId: packageName.trim() || null,
          trackOrChannel: track,
          config: { serviceAccountJson, artifactKind },
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["destinations", appId] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  const canSubmit = (() => {
    if (!name.trim()) return false;
    if (type === "app_store") {
      if (appleAuthMode === "api_key") {
        // Re-entering the .p8 is required on create, and whenever the user
        // switches auth modes (the existing api_key block may not exist yet).
        const needSecret = !isEdit || seedAuthMode !== "api_key";
        return !!issuerId.trim() && !!keyId.trim() && (!needSecret || p8.trim().length > 0);
      }
      const needSecret = !isEdit || seedAuthMode !== "altool";
      return !!appleId.trim() && (!needSecret || appSpecificPassword.length > 0);
    }
    return !!packageName.trim() && (isEdit || jsonKeyFile != null);
  })();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        onPointerDownOutside={isEdit ? (e) => e.preventDefault() : undefined}
        onInteractOutside={isEdit ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={isEdit ? (e) => e.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Store Destination" : "Add Store Destination"}</DialogTitle>
        </DialogHeader>
        <div className="dialog-body">
          <div className="field-group">
            <Label htmlFor="dest-name">Name</Label>
            <Input id="dest-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          {!isEdit && (
            <div className="field-group">
              <Label htmlFor="dest-type">Type</Label>
              <Combobox<DestType>
                id="dest-type"
                value={type}
                onChange={setType}
                options={DEST_OPTIONS}
              />
            </div>
          )}

          {type === "app_store" ? (
            <AppleFields
              isEdit={isEdit}
              authMode={appleAuthMode}
              setAuthMode={setAppleAuthMode}
              originalAuthMode={isEdit ? seedAuthMode : null}
              appleId={appleId}
              setAppleId={setAppleId}
              appSpecificPassword={appSpecificPassword}
              setAppSpecificPassword={setAppSpecificPassword}
              appAppleId={appAppleId}
              setAppAppleId={setAppAppleId}
              teamId={teamId}
              setTeamId={setTeamId}
              issuerId={issuerId}
              setIssuerId={setIssuerId}
              keyId={keyId}
              setKeyId={setKeyId}
              p8={p8}
              setP8={setP8}
            />
          ) : (
            <GoogleFields
              isEdit={isEdit}
              track={track}
              setTrack={setTrack}
              packageName={packageName}
              setPackageName={setPackageName}
              artifactKind={artifactKind}
              setArtifactKind={setArtifactKind}
              jsonKeyFile={jsonKeyFile}
              setJsonKeyFile={setJsonKeyFile}
            />
          )}

          {error && <p className="text-error">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!canSubmit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AppleFieldsProps {
  isEdit: boolean;
  authMode: AppleAuthMode;
  setAuthMode: (m: AppleAuthMode) => void;
  /** Auth mode the destination was saved with — secret prefills only "keep" when this matches the current mode. */
  originalAuthMode: AppleAuthMode | null;
  appleId: string; setAppleId: (v: string) => void;
  appSpecificPassword: string; setAppSpecificPassword: (v: string) => void;
  appAppleId: string; setAppAppleId: (v: string) => void;
  teamId: string; setTeamId: (v: string) => void;
  issuerId: string; setIssuerId: (v: string) => void;
  keyId: string; setKeyId: (v: string) => void;
  p8: string; setP8: (v: string) => void;
}

function AppleFields(p: AppleFieldsProps) {
  const keepHint = "Leave blank to keep current";
  const passwordKeep = p.isEdit && p.originalAuthMode === "altool";
  const p8Keep = p.isEdit && p.originalAuthMode === "api_key";
  const [resettingPassword, setResettingPassword] = useState(false);
  const showPasswordInput = !passwordKeep || resettingPassword;
  return (
    <>
      {!p.isEdit && (
        <div className="field-group">
          <Label htmlFor="apple-auth-mode">Authentication method</Label>
          <Combobox<AppleAuthMode>
            id="apple-auth-mode"
            value={p.authMode}
            onChange={p.setAuthMode}
            options={[
              { value: "altool", label: "Apple ID + app-specific password" },
              { value: "api_key", label: "App Store Connect API key (.p8)" },
            ]}
          />
        </div>
      )}

      {p.authMode === "altool" ? (
        <>
          <div className="field-group">
            <Label htmlFor="apple-id">Apple ID</Label>
            <p className="new-build-help">Your Apple ID username for your Apple Developer account</p>
            <Input id="apple-id" type="email" value={p.appleId} onChange={(e) => p.setAppleId(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="field-group">
            <Label htmlFor="asp">App-specific password</Label>
            <p className="new-build-help">
              Generate an app-specific password on your{" "}
              <a className="link" href="https://appleid.apple.com/account/home" target="_blank" rel="noreferrer">
                Apple ID account page
              </a>
            </p>
            {showPasswordInput ? (
              <Input
                id="asp"
                type="password"
                value={p.appSpecificPassword}
                onChange={(e) => p.setAppSpecificPassword(e.target.value)}
                placeholder={passwordKeep ? keepHint : "xxxx-xxxx-xxxx-xxxx"}
                autoFocus={resettingPassword}
              />
            ) : (
              <div className="password-hidden-field" aria-describedby="asp-hidden-note">
                <span className="password-hidden-field__label" id="asp-hidden-note">
                  <Lock size={14} aria-hidden /> Password hidden
                </span>
                <button
                  type="button"
                  className="password-hidden-field__reset"
                  onClick={() => setResettingPassword(true)}
                >
                  Reset password
                </button>
              </div>
            )}
          </div>
          <div className="field-group">
            <Label htmlFor="app-apple-id">App Apple ID</Label>
            <p className="new-build-help">
              Apple ID property from the App Information section in{" "}
              <a className="link" href="https://appstoreconnect.apple.com/" target="_blank" rel="noreferrer">
                App Store Connect
              </a>
            </p>
            <Input id="app-apple-id" value={p.appAppleId} onChange={(e) => p.setAppAppleId(e.target.value)} placeholder="1234567890" />
          </div>
          <div className="field-group">
            <Label htmlFor="team-id">Team ID</Label>
            <p className="new-build-help">
              Available in your Apple Developer account in the{" "}
              <a className="link" href="https://developer.apple.com/account/#/membership" target="_blank" rel="noreferrer">
                Membership Details
              </a>
            </p>
            <Input id="team-id" value={p.teamId} onChange={(e) => p.setTeamId(e.target.value)} placeholder="ABCDE12345" />
          </div>
        </>
      ) : (
        <>
          <div className="field-group">
            <Label htmlFor="issuer">Issuer ID</Label>
            <Input id="issuer" value={p.issuerId} onChange={(e) => p.setIssuerId(e.target.value)} />
          </div>
          <div className="field-group">
            <Label htmlFor="key-id">Key ID</Label>
            <Input id="key-id" value={p.keyId} onChange={(e) => p.setKeyId(e.target.value)} />
          </div>
          <div className="field-group">
            <Label htmlFor="p8">Private key (.p8)</Label>
            <textarea
              id="p8"
              className="textarea"
              value={p.p8}
              onChange={(e) => p.setP8(e.target.value)}
              placeholder={p8Keep ? keepHint : "-----BEGIN PRIVATE KEY-----..."}
            />
          </div>
        </>
      )}
    </>
  );
}

interface GoogleFieldsProps {
  isEdit: boolean;
  track: string; setTrack: (v: string) => void;
  packageName: string; setPackageName: (v: string) => void;
  artifactKind: AndroidArtifactKind; setArtifactKind: (v: AndroidArtifactKind) => void;
  jsonKeyFile: File | null; setJsonKeyFile: (v: File | null) => void;
}

function GoogleFields(p: GoogleFieldsProps) {
  return (
    <>
      <div className="field-group">
        <Label htmlFor="track">Track</Label>
        <p className="new-build-help">Google Play track type</p>
        <Combobox id="track" value={p.track} onChange={p.setTrack} options={TRACK_OPTIONS} />
      </div>

      <div className="field-group">
        <Label htmlFor="pkg-name">Package name</Label>
        <p className="new-build-help">Reverse domain name of the project</p>
        <Input id="pkg-name" value={p.packageName} onChange={(e) => p.setPackageName(e.target.value)} placeholder="com.acme.myapp" />
      </div>

      <div className="field-group">
        <Label>Publishing format</Label>
        <p className="new-build-help">Specify which type of Android build artifact you'd like to deploy to Google Play.</p>
        <RadioGroup<AndroidArtifactKind>
          value={p.artifactKind}
          onChange={p.setArtifactKind}
          options={[
            { value: "aab", label: "Android App Bundles (AAB)" },
            { value: "apk", label: "APK" },
          ]}
        />
      </div>

      <div className="field-group">
        <Label htmlFor="sa-json">JSON key file</Label>
        <p className="new-build-help">
          {p.isEdit
            ? "Leave empty to keep the current key. Drop a new JSON file to replace it."
            : "JSON file from Google that contains the keys needed to upload."}
        </p>
        <FileDrop
          id="sa-json"
          accept="application/json,.json"
          value={p.jsonKeyFile}
          onChange={(files) => p.setJsonKeyFile(files[0] ?? null)}
        />
      </div>
    </>
  );
}
