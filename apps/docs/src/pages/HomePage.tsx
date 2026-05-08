import { FeatureCard } from "@/components/FeatureCard";

export function HomePage() {
  return (
    <div className="home-page">
      <section className="hero">
        <div className="hero-pill">MobileFlow v0.0.0</div>
        <h1>Build and deploy mobile apps in the cloud</h1>
        <p className="hero-subtitle">
          A cloud build and deploy platform for Capacitor, Cordova, React Native, iOS Native, and Android Native apps.
        </p>
        <div className="hero-actions">
          <a href="/installation" className="btn btn-primary">
            Get Started
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </a>
          <a href="/features" className="btn btn-secondary">Explore Features</a>
        </div>
      </section>

      <section className="features-grid">
        <FeatureCard
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          }
          title="Multi-Platform Builds"
          description="Build Android, iOS, and Web apps from a single dashboard with native runners on Linux Docker and Mac VMs."
        />
        <FeatureCard
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          }
          title="Live Log Streaming"
          description="Watch builds in real-time with WebSocket-powered log streaming and structured pipeline step tracking."
        />
        <FeatureCard
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          }
          title="Secure Secrets"
          description="AES-256-GCM encryption at rest for keystores, provisioning profiles, and environment variables."
        />
        <FeatureCard
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          }
          title="Store Deployment"
          description="Deploy directly to the App Store, TestFlight, and Google Play with configured destinations and tracks."
        />
        <FeatureCard
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          }
          title="SSO & Auth"
          description="Email and password with argon2, plus Google and GitHub OIDC sign-in with account linking."
        />
        <FeatureCard
          icon={
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
          title="Stripe Billing"
          description="Tiered subscription plans with Stripe Checkout, Customer Portal, and webhook-driven plan enforcement."
        />
      </section>

      <section className="status-section">
        <h2>Status Snapshot</h2>
        <p>
          The MobileFlow alpha is functional end-to-end. Here is what is already working:
        </p>
        <ul>
          <li>Monorepo with pnpm workspaces</li>
          <li>Tauri desktop app wrapping the React web UI</li>
          <li>API with Postgres, Drizzle ORM, sessions, and auth</li>
          <li>Google and GitHub single sign-on</li>
          <li>App management with multi-provider git connections (GitHub, GitLab, Bitbucket)</li>
          <li>Live builds with WebSocket log streaming</li>
          <li>Real Linux Android, Linux Web, and Mac iOS runners</li>
          <li>Environments, signing certificates, and store destinations</li>
          <li>Deployments with real <code>xcrun altool</code> and Google Play Publisher API runners</li>
          <li>Stripe Checkout, Customer Portal, and webhooks</li>
          <li>Superadmin console for organizations, users, builds, hosts, plans, and OAuth apps</li>
        </ul>
      </section>
    </div>
  );
}
