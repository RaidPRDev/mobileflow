import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Apple, MoreVertical, Smartphone } from "lucide-react";
import {
  Button,
  Combobox,
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
  RadioGroup,
  type ComboboxOption,
} from "@mobileflow/ui";
import appStoreIcon from "@assets/icons/app-store-icon.svg";
import googlePlayIcon from "@assets/icons/google-playstore-icon.svg";
import { ApiError, api } from "../api/client";

type DestType = "app_store" | "play_store";

const TYPE_LABEL: Record<DestType, string> = {
  app_store: "Apple App Store",
  play_store: "Google Play Store",
};

const TYPE_PLATFORM: Record<DestType, "ios" | "android"> = {
  app_store: "ios",
  play_store: "android",
};

const TYPE_ICON_SRC: Record<DestType, string> = {
  app_store: appStoreIcon,
  play_store: googlePlayIcon,
};

function destIcon(type: DestType, size = 18) {
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
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Store destinations</h1>
        <div className="page-actions">
          <Button onClick={() => setOpen(true)}>Add destination</Button>
        </div>
      </div>

      {open && <DestDialog appId={appId!} onClose={() => setOpen(false)} />}

      <div className="page-section">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Platform</th>
              <th>Identifier</th>
              <th className="col-actions" aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((d) => {
              const type = d.type as DestType;
              const platform = TYPE_PLATFORM[type];
              return (
                <tr key={d.id}>
                  <td>
                    <div className="data-row-name">{d.name}</div>
                    {d.trackOrChannel && <div className="data-row-meta">{d.trackOrChannel}</div>}
                  </td>
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      {destIcon(type)}
                      <span>{TYPE_LABEL[type] ?? type}</span>
                    </span>
                  </td>
                  <td>
                    <span className="data-row-platform">
                      <span className={`data-row-platform-icon is-${platform}`}>
                        {platform === "ios" ? <Apple size={12} /> : <Smartphone size={12} />}
                      </span>
                      <span>{platform === "ios" ? "iOS" : "Android"}</span>
                    </span>
                  </td>
                  <td>
                    <span className="data-row-meta">{d.bundleId ?? "—"}</span>
                  </td>
                  <td className="col-actions">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton variant="menu" aria-label="More actions">
                          <MoreVertical size={16} />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem destructive onSelect={() => remove.mutate(d.id)}>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {q.data?.length === 0 && <div className="empty-state">No destinations yet.</div>}
      </div>
    </div>
  );
}

function DestDialog({ appId, onClose }: { appId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<DestType>("app_store");
  const [name, setName] = useState("");

  // Apple fields
  const [appleAuthMode, setAppleAuthMode] = useState<AppleAuthMode>("altool");
  const [appleId, setAppleId] = useState("");
  const [appSpecificPassword, setAppSpecificPassword] = useState("");
  const [appAppleId, setAppAppleId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [issuerId, setIssuerId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [p8, setP8] = useState("");

  // Android fields
  const [track, setTrack] = useState<string>("internal");
  const [packageName, setPackageName] = useState("");
  const [artifactKind, setArtifactKind] = useState<AndroidArtifactKind>("aab");
  const [jsonKeyFile, setJsonKeyFile] = useState<File | null>(null);

  const [error, setError] = useState<string | null>(null);

  const readFileText = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error("Could not read file"));
      fr.onload = () => resolve(String(fr.result ?? ""));
      fr.readAsText(file);
    });

  const create = useMutation({
    mutationFn: async () => {
      if (type === "app_store") {
        const config =
          appleAuthMode === "api_key"
            ? { authMode: "api_key", issuerId, keyId, privateKeyP8: p8 }
            : { authMode: "altool", appleId, appSpecificPassword, appAppleId, teamId };
        return api.createDestination(appId, {
          name: name.trim(),
          type,
          bundleId: appAppleId.trim() || null,
          trackOrChannel: null,
          config,
        });
      } else {
        const serviceAccountJson = jsonKeyFile ? await readFileText(jsonKeyFile) : "";
        return api.createDestination(appId, {
          name: name.trim(),
          type,
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
      return appleAuthMode === "api_key"
        ? issuerId.trim() && keyId.trim() && p8.trim().length > 0
        : appleId.trim() && appSpecificPassword.length > 0;
    }
    return packageName.trim() && jsonKeyFile != null;
  })();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Store Destination</DialogTitle>
        </DialogHeader>
        <div className="dialog-body">
          <div className="field-group">
            <Label htmlFor="dest-name">Name</Label>
            <Input id="dest-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="field-group">
            <Label htmlFor="dest-type">Type</Label>
            <Combobox<DestType>
              id="dest-type"
              value={type}
              onChange={setType}
              options={DEST_OPTIONS}
            />
          </div>

          {type === "app_store" ? (
            <AppleFields
              authMode={appleAuthMode}
              setAuthMode={setAppleAuthMode}
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
          <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!canSubmit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AppleFieldsProps {
  authMode: AppleAuthMode;
  setAuthMode: (m: AppleAuthMode) => void;
  appleId: string; setAppleId: (v: string) => void;
  appSpecificPassword: string; setAppSpecificPassword: (v: string) => void;
  appAppleId: string; setAppAppleId: (v: string) => void;
  teamId: string; setTeamId: (v: string) => void;
  issuerId: string; setIssuerId: (v: string) => void;
  keyId: string; setKeyId: (v: string) => void;
  p8: string; setP8: (v: string) => void;
}

function AppleFields(p: AppleFieldsProps) {
  return (
    <>
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

      {p.authMode === "altool" ? (
        <>
          <div className="field-group">
            <Label htmlFor="apple-id">Apple ID</Label>
            <Input id="apple-id" type="email" value={p.appleId} onChange={(e) => p.setAppleId(e.target.value)} placeholder="you@example.com" />
          </div>
          <div className="field-group">
            <Label htmlFor="asp">App-specific password</Label>
            <Input id="asp" type="password" value={p.appSpecificPassword} onChange={(e) => p.setAppSpecificPassword(e.target.value)} placeholder="xxxx-xxxx-xxxx-xxxx" />
          </div>
          <div className="field-group">
            <Label htmlFor="app-apple-id">App Apple ID</Label>
            <Input id="app-apple-id" value={p.appAppleId} onChange={(e) => p.setAppAppleId(e.target.value)} placeholder="1234567890" />
          </div>
          <div className="field-group">
            <Label htmlFor="team-id">Team ID</Label>
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
              placeholder="-----BEGIN PRIVATE KEY-----..."
            />
          </div>
        </>
      )}
    </>
  );
}

interface GoogleFieldsProps {
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
        <p className="new-build-help">JSON file from Google that contains the keys needed to upload.</p>
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

