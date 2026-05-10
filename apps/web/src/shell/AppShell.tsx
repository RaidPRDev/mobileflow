import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { LayoutGrid, Settings, ShieldCheck } from "lucide-react";
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
    <div className="app-shell">
      <OuterRail orgId={fallbackOrgId} isSuperadmin={!!me?.user.isSuperadmin} />
      <InnerRail inAppScope={inAppScope} orgId={fallbackOrgId} appId={appId} />
      <main className="app-main">
        <header className="app-header">
          <ThemeToggle />
          <span className="app-header-user">{me?.user.email}</span>
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

function OuterRail({ orgId, isSuperadmin }: { orgId: string; isSuperadmin: boolean }) {
  return (
    <aside className="app-rail-outer">
      <Link to={`/org/${orgId}/apps`} className="app-rail-brand" title="MobileFlow">
        MF
      </Link>
      <div className="app-rail-icons">
        <RailIcon to={`/org/${orgId}/apps`} label="Apps">
          <LayoutGrid size={18} />
        </RailIcon>
        <RailIcon to={`/org/${orgId}/settings`} label="Settings">
          <Settings size={18} />
        </RailIcon>
        {isSuperadmin && (
          <RailIcon to="/admin" label="Admin">
            <ShieldCheck size={18} />
          </RailIcon>
        )}
      </div>
    </aside>
  );
}

function RailIcon({
  to,
  label,
  children,
}: {
  to: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      title={label}
      className={({ isActive }) => cn("app-rail-icon", isActive && "is-active")}
    >
      {children}
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
    <aside className="app-rail-inner app-scroll">
      <div className="app-rail-section-title">{inAppScope ? "App" : "Organization"}</div>
      <nav className="app-rail-nav">
        {inAppScope && appId ? (
          <>
            <NavItem to={`/app/${appId}/commits`} label="Commits" />
            <NavItem to={`/app/${appId}/builds`} label="Builds" />
            <div className="app-rail-section-divider">Build</div>
            <NavItem to={`/app/${appId}/builds/environments`} label="Environments" />
            <NavItem to={`/app/${appId}/builds/certificates`} label="Signing Certificates" />
            <div className="app-rail-section-divider">Deploy</div>
            <NavItem to={`/app/${appId}/deploy/deployments`} label="Deployments" />
            <NavItem to={`/app/${appId}/deploy/destinations`} label="Store Destinations" />
            <div className="app-rail-section-divider">App</div>
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
      className={({ isActive }) => cn("app-rail-nav-item", isActive && "is-active")}
    >
      {label}
    </NavLink>
  );
}
