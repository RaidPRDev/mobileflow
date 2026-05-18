import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { ChevronDown, LayoutGrid, Settings, ShieldCheck } from "lucide-react";
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
      <Link
        to={`/org/${orgId}/apps`}
        className="app-rail-brand tooltip-wrap"
        aria-label="MobileFlow"
      >
        MF
        <span className="tooltip-bubble tooltip-bubble--right" role="tooltip">
          MobileFlow
        </span>
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
      aria-label={label}
      className={({ isActive }) => cn("app-rail-icon tooltip-wrap", isActive && "is-active")}
    >
      {children}
      <span className="tooltip-bubble tooltip-bubble--right" role="tooltip">
        {label}
      </span>
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
            <NavSection
              label="Build"
              basePath={`/app/${appId}/build`}
              landingPath={`/app/${appId}/build/builds`}
            >
              <NavItem to={`/app/${appId}/build/builds`} label="Builds" sub />
              <NavItem to={`/app/${appId}/build/environments`} label="Environments" sub />
              <NavItem to={`/app/${appId}/build/certificates`} label="Signing Certificates" sub />
            </NavSection>
            <NavSection
              label="Deploy"
              basePath={`/app/${appId}/deploy`}
              landingPath={`/app/${appId}/deploy/deployments`}
            >
              <NavItem to={`/app/${appId}/deploy/deployments`} label="Deployments" sub />
              <NavItem to={`/app/${appId}/deploy/store-destinations`} label="Store Destinations" sub />
            </NavSection>
            <div className="app-rail-section-divider">App</div>
            <NavSection
              label="Settings"
              basePath={`/app/${appId}/settings`}
              landingPath={`/app/${appId}/settings/general`}
            >
              <NavItem to={`/app/${appId}/settings/general`} label="General" sub />
              <NavItem to={`/app/${appId}/settings/git`} label="Git" sub />
            </NavSection>
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

function NavItem({ to, label, sub }: { to: string; label: string; sub?: boolean }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        cn("app-rail-nav-item", sub && "is-sub", isActive && "is-active")
      }
    >
      {label}
    </NavLink>
  );
}

function NavSection({
  label,
  basePath,
  landingPath,
  children,
}: {
  label: string;
  basePath: string;
  landingPath: string;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const open = location.pathname === basePath || location.pathname.startsWith(`${basePath}/`);

  return (
    <div className={cn("app-rail-nav-section", open && "is-open")}>
      <NavLink
        to={landingPath}
        className={cn("app-rail-nav-item app-rail-nav-section-toggle", open && "is-active")}
      >
        <span>{label}</span>
        <ChevronDown size={14} className="app-rail-nav-section-chev" aria-hidden />
      </NavLink>
      {open && <div className="app-rail-nav-section-children">{children}</div>}
    </div>
  );
}
