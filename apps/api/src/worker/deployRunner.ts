import type { App, Build, Deployment, StoreDestination } from "../db/schema.js";

export interface DeployContext {
  deployment: Deployment;
  destination: StoreDestination;
  build: Build;
  app: App;
  /** Decrypted destination credentials JSON. */
  config: Record<string, unknown>;
  /** Append a line to the deployment's logText (and stream subscribers later). */
  log: (line: string) => Promise<void>;
}

export interface DeployRunner {
  run(ctx: DeployContext): Promise<void>;
}

/**
 * Helpers shared by real upload runners.
 */
export function artifactByKind(build: Build, kinds: string[]): { kind: string; url: string } | null {
  const arts = (build.artifacts ?? []) as { kind: string; url: string }[];
  for (const k of kinds) {
    const a = arts.find((x) => x.kind === k);
    if (a) return a;
  }
  return null;
}

export function fileNameFromUrl(url: string): string {
  return url.split("/").pop()?.split("?")[0] ?? "artifact";
}
