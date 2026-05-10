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
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">No organization</h1>
      </div>
      <p className="page-subtitle">Your account isn't a member of any organization yet.</p>
    </div>
  );
}
