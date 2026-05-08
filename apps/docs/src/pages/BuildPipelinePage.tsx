import { CodeBlock } from "@/components/CodeBlock";

export function BuildPipelinePage() {
  return (
    <div>
      <h1>Build Pipeline</h1>
      <p>
        Every build follows a consistent pipeline from queue to cleanup. Each
        step emits structured events so the UI can render progress and logs in
        real time.
      </p>

      <h2>Pipeline shape</h2>
      <CodeBlock
        code={`queued
  → preparing      (clone repo, materialize secrets)
  → installing     (npm ci / pod install / gradle deps)
  → building       (xcodebuild / gradle / capacitor sync)
  → signing        (codesign / jarsigner / apksigner)
  → packaging      (ipa / aab / apk / dSYM / xcarchive)
  → publishing     (upload to artifact store)
  → cleanup        (remove sandbox, revoke keychain)
  → success | failed | cancelled`}
        language="text"
      />

      <h2>Step events</h2>
      <p>
        Each step emits a JSON event with the following shape:
      </p>
      <CodeBlock
        code={`{
  "step": "building",
  "status": "running",
  "startedAt": "2026-05-07T12:00:00Z",
  "endedAt": null,
  "exitCode": null
}`}
        language="json"
      />

      <h2>Log streaming</h2>
      <p>
        Build stdout and stderr are captured into a per-build log file and
        appended to the <code>builds.log_text</code> column. A WebSocket fan-out
        broadcasts new lines to all subscribers viewing the build. If the
        WebSocket disconnects, the UI falls back to short polling.
      </p>

      <h2>Source delivery</h2>
      <p>
        Instead of uploading a zip from the user&apos;s machine, the worker runs{" "}
        <code>git clone --depth 1 --branch &lt;ref&gt;</code> directly on the
        build host using the organization&apos;s stored OAuth token. This avoids
        round-tripping source through the orchestrator and removes the need for
        the user to have the project locally.
      </p>

      <h2>Secret materialization</h2>
      <p>
        Before the build starts, the runner decrypts the organization&apos;s
        signing certificates and environment variables into a per-build sandbox
        directory. The sandbox is always cleaned up in a <code>trap</code>, even
        on failure or cancellation.
      </p>

      <h2>Host scheduling</h2>
      <p>
        The worker queries the <code>build_hosts</code> table for the first
        online host that matches the required platform. Load-aware scheduling is
        deferred; currently the worker picks the first available host. A
        per-host semaphore prevents overcommitting the Mac keychain or Docker
        daemon.
      </p>

      <h2>Artifact storage</h2>
      <p>
        Successful builds upload artifacts to the configured file server. URLs
        are currently public; signed/HMAC URLs are planned for a future release.
        Artifact retention is not automatically expired in v1.
      </p>
    </div>
  );
}
