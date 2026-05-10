import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export function RootRedirect() {
  const { me } = useAuth();
  const org = me?.organizations[0];
  if (org) {
    return <Navigate to={`/org/${org.orgId}/apps`} replace />;
  }
  if (me?.user.isSuperadmin) {
    return <Navigate to="/admin" replace />;
  }
  return (
    <div className="grid gap-2">
      <h1 className="text-xl font-semibold">No organization</h1>
      <p className="text-sm text-muted-foreground">
        Your account isn't a member of any organization yet.
      </p>
    </div>
  );
}
