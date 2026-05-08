import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { Button, cn } from "@mobileflow/ui";
import { ThemeToggle } from "../theme/ThemeToggle";
import { useAuth } from "../auth/AuthProvider";

export function AppShell() {
  const location = useLocation();
  const { orgId, appId } = useParams();
  const { me, signOut } = useAuth();

  const inAppScope = location.pathname.startsWith("/app/");
  const fallbackOrgId = me?.organizations[0]?.orgId ?? orgId ?? "";

  return (
    <div className="flex h-full bg-background">
      <OuterRail orgId={fallbackOrgId} isSuperadmin={!!me?.user.isSuperadmin} />
      <InnerRail inAppScope={inAppScope} orgId={fallbackOrgId} appId={appId} />
      <main className="flex-1 min-w-0 overflow-auto">
        <header className="h-14 border-b flex items-center justify-end px-4 gap-3">
          <ThemeToggle />
          <span className="text-sm text-muted-foreground hidden sm:inline">
            {me?.user.email}
          </span>
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

function OuterRail({ orgId, isSuperadmin }: { orgId: string; isSuperadmin: boolean }) {
  return (
    <aside className="w-16 shrink-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col items-center py-3 gap-2">
      <Link
        to={`/org/${orgId}/apps`}
        className="h-10 w-10 rounded-md bg-primary text-primary-foreground grid place-items-center font-bold"
        title="MobileFlow"
      >
        MF
      </Link>
      <div className="mt-2 flex flex-col gap-1">
        <RailIcon to={`/org/${orgId}/apps`} label="Apps" glyph="A" />
        <RailIcon to={`/org/${orgId}/settings`} label="Settings" glyph="S" />
        {isSuperadmin && <RailIcon to="/admin" label="Admin" glyph="★" />}
      </div>
    </aside>
  );
}

function RailIcon({ to, label, glyph }: { to: string; label: string; glyph: string }) {
  return (
    <NavLink
      to={to}
      title={label}
      className={({ isActive }) =>
        cn(
          "h-10 w-10 rounded-md grid place-items-center text-sm font-medium",
          isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
        )
      }
    >
      {glyph}
    </NavLink>
  );
}

function InnerRail({
  inAppScope,
  orgId,
  appId,
}: {
  inAppScope: boolean;
  orgId: string;
  appId: string | undefined;
}) {
  return (
    <aside
      className="shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
      style={{ width: 230 }}
    >
      <div className="px-4 py-3 text-xs uppercase tracking-wide text-muted-foreground">
        {inAppScope ? "App" : "Organization"}
      </div>
      <nav className="px-2 grid gap-1">
        {inAppScope && appId ? (
          <>
            <NavItem to={`/app/${appId}/commits`} label="Commits" />
            <NavItem to={`/app/${appId}/builds`} label="Builds" />
            <div className="mt-3 px-2 text-xs text-muted-foreground">Build</div>
            <NavItem to={`/app/${appId}/builds/environments`} label="Environments" />
            <NavItem to={`/app/${appId}/builds/certificates`} label="Signing Certificates" />
            <div className="mt-3 px-2 text-xs text-muted-foreground">Deploy</div>
            <NavItem to={`/app/${appId}/deploy/deployments`} label="Deployments" />
            <NavItem to={`/app/${appId}/deploy/destinations`} label="Store Destinations" />
            <div className="mt-3 px-2 text-xs text-muted-foreground">App</div>
            <NavItem to={`/app/${appId}/settings`} label="Settings" />
          </>
        ) : (
          <>
            <NavItem to={`/org/${orgId}/apps`} label="Apps" />
            <NavItem to={`/org/${orgId}/settings/account`} label="Account" />
            <NavItem to={`/org/${orgId}/settings/subscriptions`} label="Subscriptions" />
            <NavItem to={`/org/${orgId}/settings/usage`} label="Usage" />
          </>
        )}
      </nav>
    </aside>
  );
}

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "px-3 py-1.5 rounded-md text-sm",
          isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
        )
      }
    >
      {label}
    </NavLink>
  );
}
