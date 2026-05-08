import { CodeBlock } from "@/components/CodeBlock";

export function DeploymentPage() {
  return (
    <div>
      <h1>Deployment</h1>
      <p>
        MobileFlow can deploy successful builds directly to the App Store,
        TestFlight, and Google Play. Destinations are configured once per app
        and reused across deployments.
      </p>

      <h2>Store destinations</h2>
      <p>
        A store destination holds the credentials and target configuration for a
        specific platform store:
      </p>
      <ul>
        <li>
          <strong>App Store / TestFlight</strong>: App Store Connect API key
          (p8 file), Issuer ID, and Key ID.
        </li>
        <li>
          <strong>Google Play</strong>: Service account JSON and target track
          (internal, alpha, beta, production).
        </li>
      </ul>

      <h2>Creating a deployment</h2>
      <p>
        A deployment pairs a successful build with a destination. The worker
        enqueues the deploy job and runs it through the appropriate runner:
      </p>
      <CodeBlock
        code={`deployment queued
  → materialize credentials
  → upload artifact to store
  → assign to track (Google Play)
  → submit for review (App Store)
  → success | failed`}
        language="text"
      />

      <h2>iOS deployment</h2>
      <p>
        The <code>AppStoreUploadRunner</code> connects to the Mac build host
        over SSH, materializes the App Store Connect API key, and runs{" "}
        <code>xcrun altool</code> to upload the IPA. For TestFlight, the same
        upload path is used; release assignment happens in App Store Connect.
      </p>

      <h2>Android deployment</h2>
      <p>
        The <code>GooglePlayUploadRunner</code> uses the Google Play Developer
        API. It creates an edit, uploads the AAB or APK, assigns the release to
        the selected track, and commits the edit. The service account must have
        release manager access to the Play Console.
      </p>

      <h2>Fallback behavior</h2>
      <p>
        If no host is configured or credentials are missing, the runner falls
        back to a <code>StubDeployRunner</code> that logs the would-be actions
        without side effects. This is useful for local development and testing.
      </p>
    </div>
  );
}
