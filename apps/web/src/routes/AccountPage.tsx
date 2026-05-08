import { Card, CardContent, CardHeader, CardTitle } from "@mobileflow/ui";
import { useAuth } from "../auth/AuthProvider";

export function AccountPage() {
  const { me } = useAuth();
  if (!me) return null;
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-semibold">Account</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm">
          <Row label="Email" value={me.user.email} />
          <Row label="Name" value={me.user.name ?? "—"} />
          <Row label="User ID" value={me.user.id} mono />
          {me.user.isSuperadmin && <Row label="Role" value="Superadmin" />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organizations</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1 text-sm">
          {me.organizations.map((o) => (
            <div key={o.orgId} className="flex items-center justify-between border-b last:border-0 py-1">
              <span className="font-medium">{o.name}</span>
              <span className="text-xs text-muted-foreground">{o.role}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b last:border-0 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value}</span>
    </div>
  );
}
