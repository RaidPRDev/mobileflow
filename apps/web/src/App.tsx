import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "./routes/LoginPage";
import { OAuthCallbackPage } from "./routes/OAuthCallbackPage";
import { AppShell } from "./shell/AppShell";
import { AppsPage } from "./routes/AppsPage";
import { ImportAppPage } from "./routes/ImportAppPage";
import { CommitsPage } from "./routes/CommitsPage";
import { BuildsPage } from "./routes/BuildsPage";
import { NewBuildPage } from "./routes/NewBuildPage";
import { BuildPage } from "./routes/BuildPage";
import { AppSettingsLayout } from "./routes/AppSettingsLayout";
import { AppGeneralSettingsPage } from "./routes/AppGeneralSettingsPage";
import { AppGitSettingsPage } from "./routes/AppGitSettingsPage";
import { EnvironmentsPage } from "./routes/EnvironmentsPage";
import { CertificatesPage } from "./routes/CertificatesPage";
import { StoreDestinationsPage } from "./routes/StoreDestinationsPage";
import { StoreDestinationDetailPage } from "./routes/StoreDestinationDetailPage";
import { DeploymentsPage } from "./routes/DeploymentsPage";
import { NewDeploymentPage } from "./routes/NewDeploymentPage";
import { OrgSettingsLayout } from "./routes/OrgSettingsLayout";
import { AccountPage } from "./routes/AccountPage";
import { SubscriptionsPage } from "./routes/SubscriptionsPage";
import { UsagePage } from "./routes/UsagePage";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { RootRedirect } from "./auth/RootRedirect";
import { AdminLayout } from "./admin/AdminLayout";
import { AdminOverviewPage } from "./admin/AdminOverviewPage";
import { AdminOrgsPage } from "./admin/AdminOrgsPage";
import { AdminOrgDetailPage } from "./admin/AdminOrgDetailPage";
import { AdminUsersPage } from "./admin/AdminUsersPage";
import { AdminBuildsPage } from "./admin/AdminBuildsPage";
import { AdminPlansPage } from "./admin/AdminPlansPage";
import { AdminPlanEditPage } from "./admin/AdminPlanEditPage";
import { AdminStacksPage } from "./admin/AdminStacksPage";
import { AdminStackEditPage } from "./admin/AdminStackEditPage";
import { AdminHostsPage } from "./admin/AdminHostsPage";
import { AdminOAuthAppsPage } from "./admin/AdminOAuthAppsPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<OAuthCallbackPage />} />

      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<RootRedirect />} />
        <Route path="/org/:orgId/apps" element={<AppsPage />} />
        <Route path="/org/:orgId/apps/import" element={<ImportAppPage />} />
        <Route path="/org/:orgId/settings" element={<OrgSettingsLayout />}>
          <Route index element={<AccountPage />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="subscriptions" element={<SubscriptionsPage />} />
          <Route path="usage" element={<UsagePage />} />
        </Route>
        <Route path="/app/:appId/commits" element={<CommitsPage />} />
        <Route path="/app/:appId/build" element={<Navigate to="builds" replace />} />
        <Route path="/app/:appId/build/builds" element={<BuildsPage />} />
        <Route path="/app/:appId/build/builds/new" element={<NewBuildPage />} />
        <Route path="/app/:appId/build/builds/:buildId" element={<BuildPage />} />
        <Route path="/app/:appId/build/environments" element={<EnvironmentsPage />} />
        <Route path="/app/:appId/build/certificates" element={<CertificatesPage />} />
        <Route path="/app/:appId/deploy" element={<Navigate to="deployments" replace />} />
        <Route path="/app/:appId/deploy/deployments" element={<DeploymentsPage />} />
        <Route path="/app/:appId/deploy/deployments/new" element={<NewDeploymentPage />} />
        <Route path="/app/:appId/deploy/destinations" element={<Navigate to="../store-destinations" replace />} />
        <Route path="/app/:appId/deploy/store-destinations" element={<StoreDestinationsPage />} />
        <Route path="/app/:appId/deploy/store-destinations/:destId" element={<StoreDestinationDetailPage />} />
        <Route path="/app/:appId/git" element={<Navigate to="../settings/git" replace />} />
        <Route path="/app/:appId/settings" element={<AppSettingsLayout />}>
          <Route index element={<Navigate to="general" replace />} />
          <Route path="general" element={<AppGeneralSettingsPage />} />
          <Route path="git" element={<AppGitSettingsPage />} />
        </Route>
      </Route>

      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<AdminOverviewPage />} />
        <Route path="orgs" element={<AdminOrgsPage />} />
        <Route path="orgs/:orgId" element={<AdminOrgDetailPage />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="builds" element={<AdminBuildsPage />} />
        <Route path="plans" element={<AdminPlansPage />} />
        <Route path="plans/:planId" element={<AdminPlanEditPage />} />
        <Route path="stacks" element={<AdminStacksPage />} />
        <Route path="stacks/new" element={<AdminStackEditPage />} />
        <Route path="stacks/:stackId" element={<AdminStackEditPage />} />
        <Route path="hosts" element={<AdminHostsPage />} />
        <Route path="oauth-apps" element={<AdminOAuthAppsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
