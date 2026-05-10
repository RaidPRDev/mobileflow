import { Navigate, NavLink, Outlet } from "react-router-dom";
import { Button, cn } from "@mobileflow/ui";
import { useAuth } from "../auth/AuthProvider";
import { ThemeToggle } from "../theme/ThemeToggle";

export function AdminLayout() {
  const { status, me, signOut } = useAuth();
  if (status === "loading") {
    return (
      <div className="app-shell">
        <div className="empty-state" style={{ margin: "auto" }}>
          Loading…
        </div>
      </div>
    );
  }
  if (!me?.user.isSuperadmin) return <Navigate to="/" replace />;

  return (
    <div className="app-shell">
      <aside className="app-rail-inner app-scroll">
        <div className="app-rail-section-title">Admin</div>
        <nav className="app-rail-nav">
          <Item to="/admin" end label="Overview" />
          <Item to="/admin/orgs" label="Organizations" />
          <Item to="/admin/users" label="Users" />
          <Item to="/admin/builds" label="Builds" />
          <Item to="/admin/plans" label="Plans" />
          <Item to="/admin/hosts" label="Build hosts" />
          <Item to="/admin/oauth-apps" label="OAuth apps" />
        </nav>
        <div className="app-rail-nav" style={{ marginTop: 16 }}>
          <Button asChild variant="ghost" size="sm" className="admin-back-btn">
            <NavLink to="/">← Back to app</NavLink>
          </Button>
        </div>
      </aside>
      <main className="app-main">
        <header className="app-header">
          <ThemeToggle />
          <span className="app-header-user">{me.user.email}</span>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </header>
        <div className="app-content app-scroll">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function Item({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cn("app-rail-nav-item", isActive && "is-active")}
    >
      {label}
    </NavLink>
  );
}
