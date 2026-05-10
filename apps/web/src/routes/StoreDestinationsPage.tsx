import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Apple, MoreVertical, Smartphone } from "lucide-react";
import {
  Badge,
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
  IconButton,
  Input,
  Label,
  type ComboboxOption,
} from "@mobileflow/ui";
import { ApiError, api } from "../api/client";

type DestType = "app_store" | "testflight" | "play_store" | "play_internal";

const TYPE_LABEL: Record<DestType, string> = {
  app_store: "Apple App Store",
  testflight: "TestFlight",
  play_store: "Google Play (Production)",
  play_internal: "Google Play (Internal)",
};

const TYPE_PLATFORM: Record<DestType, "ios" | "android"> = {
  app_store: "ios",
  testflight: "ios",
  play_store: "android",
  play_internal: "android",
};

function destIcon(type: DestType) {
  switch (type) {
    case "app_store":
      return <span className="svc-icon is-app-store">A</span>;
    case "testflight":
      return <span className="svc-icon is-testflight">TF</span>;
    case "play_store":
      return <span className="svc-icon is-google-play">P</span>;
    case "play_internal":
      return <span className="svc-icon is-google-play-internal">PI</span>;
  }
}

const DEST_OPTIONS: ComboboxOption<DestType>[] = (Object.keys(TYPE_LABEL) as DestType[]).map(
  (t) => ({ value: t, label: TYPE_LABEL[t], icon: destIcon(t) }),
);

export function StoreDestinationsPage() {
  const { appId } = useParams();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; type: DestType } | null>(null);

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
          <Button onClick={() => { setEditing(null); setOpen(true); }}>Add destination</Button>
        </div>
      </div>

      {open && (
        <DestDialog
          appId={appId!}
          editing={editing}
          onClose={() => setOpen(false)}
        />
      )}

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
              const platform = TYPE_PLATFORM[d.type as DestType];
              return (
                <tr key={d.id}>
                  <td>
                    <div className="data-row-name">{d.name}</div>
                    {d.trackOrChannel && (
                      <div className="data-row-meta">{d.trackOrChannel}</div>
                    )}
                  </td>
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      {destIcon(d.type as DestType)}
                      <span>{TYPE_LABEL[d.type as DestType]}</span>
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
                        <DropdownMenuItem
                          onSelect={() => {
                            setEditing({ id: d.id, name: d.name, type: d.type as DestType });
                            setOpen(true);
                          }}
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          destructive
                          onSelect={() => remove.mutate(d.id)}
                        >
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

function DestDialog({
  appId,
  editing,
  onClose,
}: {
  appId: string;
  editing: { id: string; name: string; type: DestType } | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState<DestType>(editing?.type ?? "testflight");
  const [name, setName] = useState(editing?.name ?? "");
  const [bundleId, setBundleId] = useState("");
  const [track, setTrack] = useState<string>("internal");
  const [issuerId, setIssuerId] = useState("");
  const [keyId, setKeyId] = useState("");
  const [p8, setP8] = useState("");
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  const platform = TYPE_PLATFORM[type];

  const create = useMutation({
    mutationFn: () => {
      const config =
        platform === "ios"
          ? { issuerId, keyId, privateKeyP8: p8 }
          : { serviceAccountJson };
      return api.createDestination(appId, {
        name: name.trim(),
        type,
        bundleId: bundleId.trim() || null,
        trackOrChannel: platform === "android" ? track : null,
        config,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["destinations", appId] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : (err as Error).message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <div>
            <DialogTitle>{editing ? "Edit store destination" : "Add Store Destination"}</DialogTitle>
          </div>
        </DialogHeader>
        <div className="dialog-body">
          <div className="field-group">
            <Label htmlFor="dest-name">Name</Label>
            <Input
              id="dest-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My production destination"
            />
          </div>

          <div className="field-group">
            <Label htmlFor="dest-type">Type</Label>
            <Combobox<DestType>
              id="dest-type"
              value={type}
              onChange={setType}
              options={DEST_OPTIONS}
              placeholder="Select destination type"
            />
          </div>

          {platform === "ios" ? (
            <>
              <div className="field-group">
                <Label htmlFor="bundle-id">Bundle ID</Label>
                <Input
                  id="bundle-id"
                  value={bundleId}
                  onChange={(e) => setBundleId(e.target.value)}
                  placeholder="com.acme.myapp"
                />
              </div>
              <div className="field-group">
                <Label htmlFor="issuer">App Store Connect — Issuer ID</Label>
                <Input
                  id="issuer"
                  value={issuerId}
                  onChange={(e) => setIssuerId(e.target.value)}
                />
              </div>
              <div className="field-group">
                <Label htmlFor="key-id">Key ID</Label>
                <Input id="key-id" value={keyId} onChange={(e) => setKeyId(e.target.value)} />
              </div>
              <div className="field-group">
                <Label htmlFor="p8">Private key (.p8)</Label>
                <textarea
                  id="p8"
                  className="textarea"
                  value={p8}
                  onChange={(e) => setP8(e.target.value)}
                  placeholder="-----BEGIN PRIVATE KEY-----..."
                />
              </div>
            </>
          ) : (
            <>
              <div className="field-group">
                <Label htmlFor="app-id">Application ID</Label>
                <Input
                  id="app-id"
                  value={bundleId}
                  onChange={(e) => setBundleId(e.target.value)}
                  placeholder="com.acme.myapp"
                />
              </div>
              <div className="field-group">
                <Label htmlFor="track">Track</Label>
                <Combobox
                  id="track"
                  value={track}
                  onChange={setTrack}
                  options={[
                    { value: "internal", label: "Internal" },
                    { value: "alpha", label: "Alpha" },
                    { value: "beta", label: "Beta" },
                    { value: "production", label: "Production" },
                  ]}
                />
              </div>
              <div className="field-group">
                <Label htmlFor="sa-json">Service account JSON</Label>
                <textarea
                  id="sa-json"
                  className="textarea"
                  value={serviceAccountJson}
                  onChange={(e) => setServiceAccountJson(e.target.value)}
                  placeholder='{"type":"service_account",...}'
                />
              </div>
            </>
          )}

          {error && <p className="text-error">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={!name.trim() || !!editing}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
