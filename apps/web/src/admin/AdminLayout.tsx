import { Navigate, NavLink, Outlet } from "react-router-dom";
import { Button, cn } from "@mobileflow/ui";
import { useAuth } from "../auth/AuthProvider";
import { ThemeToggle } from "../theme/ThemeToggle";

export function AdminLayout() {
  const { status, me, signOut } = useAuth();
  if (status === "loading") {
    return <div className="min-h-full grid place-items-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!me?.user.isSuperadmin) return <Navigate to="/" replace />;

  return (
    <div className="flex h-full bg-background">
      <aside
        className="shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
        style={{ width: 230 }}
      >
        <div className="px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">Admin</div>
        <nav className="px-2 grid gap-1">
          <Item to="/admin" end label="Overview" />
          <Item to="/admin/orgs" label="Organizations" />
          <Item to="/admin/users" label="Users" />
          <Item to="/admin/builds" label="Builds" />
          <Item to="/admin/plans" label="Plans" />
          <Item to="/admin/hosts" label="Build hosts" />
          <Item to="/admin/oauth-apps" label="OAuth apps" />
        </nav>
        <div className="mt-6 px-2">
          <Button asChild variant="ghost" size="sm" className="w-full justify-start">
            <NavLink to="/">Back to app</NavLink>
          </Button>
        </div>
      </aside>
      <main className="flex-1 min-w-0 overflow-auto">
        <header className="h-14 border-b flex items-center justify-end px-4 gap-3">
          <ThemeToggle />
          <span className="text-sm text-muted-foreground hidden sm:inline">{me.user.email}</span>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </header>
        <div className="p-6">
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
      className={({ isActive }) =>
        cn("px-3 py-1.5 rounded-md text-sm", isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")
      }
    >
      {label}
    </NavLink>
  );
}
