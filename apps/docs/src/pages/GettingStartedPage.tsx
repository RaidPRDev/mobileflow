import { CodeBlock } from "@/components/CodeBlock";

export function GettingStartedPage() {
  return (
    <div>
      <h1>Getting Started</h1>
      <p>
        This guide walks you through creating your first app, connecting a git
        repository, and running a build on MobileFlow.
      </p>

      <h2>1. Create an account</h2>
      <p>
        Visit the web app at <code>http://127.0.0.1:5173</code> and sign up using
        email and password or one of the SSO providers (Google or GitHub). An
        organization is created for you automatically on signup.
      </p>

      <h2>2. Create an app</h2>
      <p>
        From the Apps list, click <strong>New App</strong> and choose{" "}
        <strong>Import App</strong>. You will be guided through:
      </p>
      <ol>
        <li>Choosing a runtime (Capacitor, Cordova, React Native, iOS Native, or Android Native)</li>
        <li>Selecting a git host (GitHub, GitLab, or Bitbucket)</li>
        <li>Picking a repository from the list</li>
      </ol>

      <h2>3. Connect your git host</h2>
      <p>
        If you have not connected a git provider yet, go to the app&apos;s{" "}
        <strong>Git</strong> tab and complete the OAuth flow. MobileFlow stores
        the access token securely and uses it to list repos and clone code during
        builds.
      </p>

      <h2>4. Configure signing certificates</h2>
      <p>
        Before building for a mobile platform, upload the required signing
        materials:
      </p>
      <ul>
        <li>
          <strong>iOS</strong>: a <code>.p12</code> certificate with password and
          a provisioning profile.
        </li>
        <li>
          <strong>Android</strong>: a keystore file with key alias, key password,
          and store password.
        </li>
      </ul>
      <p>
        These are encrypted at rest with AES-256-GCM and are only decrypted into
        the build sandbox at runtime.
      </p>

      <h2>5. Start a build</h2>
      <p>
        Navigate to the <strong>Commits</strong> tab, select a commit, and click{" "}
        <strong>Start build</strong>. Choose the target platform, build stack,
        build type, and optional environment.
      </p>
      <p>
        The build goes through the following pipeline steps:
      </p>
      <CodeBlock
        code={`queued → preparing → installing → building → signing → packaging → publishing → cleanup → success`}
        language="text"
      />

      <h2>6. Watch live logs</h2>
      <p>
        Click into the running build to see real-time logs streamed over
        WebSocket. Each pipeline step shows its status, start time, and end time.
      </p>

      <h2>7. Download artifacts</h2>
      <p>
        When the build succeeds, the Artifacts panel lists the generated files:
      </p>
      <ul>
        <li>Android: <code>.aab</code> and <code>.apk</code></li>
        <li>iOS: <code>.ipa</code>, dSYM, and xcarchive</li>
        <li>Web: static bundle archive</li>
      </ul>

      <h2>8. Deploy to a store</h2>
      <p>
        Go to <strong>Deploy &rarr; Store Destinations</strong> and add a
        destination:
      </p>
      <ul>
        <li>
          <strong>App Store / TestFlight</strong>: App Store Connect API key
          (p8 file, issuer ID, key ID)
        </li>
        <li>
          <strong>Google Play</strong>: service account JSON and target track
          (internal, alpha, beta, production)
        </li>
      </ul>
      <p>
        Then create a deployment by picking a successful build and a destination.
        MobileFlow handles the upload and track assignment automatically.
      </p>
    </div>
  );
}
