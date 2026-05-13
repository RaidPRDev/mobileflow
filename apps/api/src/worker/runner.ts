import type { App, Build } from "../db/schema.js";

export interface RunnerContext {
  build: Build;
  app: App;
  log: (line: string) => Promise<void>;
  step: (name: string, status: "running" | "success" | "failed" | "skipped", exitCode?: number) => Promise<void>;
  isCancelled: () => Promise<boolean>;
}

export interface Runner {
  /**
   * Execute a build. Should call `ctx.step(name, "running")` before each phase
   * and `ctx.step(name, "success" | "failed" | "skipped")` after, plus
   * `ctx.log(...)` for raw output. Throw to mark the whole build failed.
   */
  run(ctx: RunnerContext): Promise<{ artifacts?: { kind: string; url: string; sizeBytes?: number }[] }>;
}

/**
 * Stub runner — emits fake step progression so the UI works end-to-end before
 * the real SSH/Docker drivers are wired up. Replace via env BUILD_RUNNER=stub|linux|mac|...
 */
export class StubRunner implements Runner {
  async run(ctx: RunnerContext): Promise<{ artifacts: { kind: string; url: string; sizeBytes?: number }[] }> {
    const hasAutoDeploy = !!ctx.build.autoDeployDestinationId;
    const phases =
      ctx.build.target === "web"
        ? ["preparing", "installing", "building", "packaging", "publishing", "cleanup"]
        : [
            "preparing",
            "installing",
            "building",
            "signing",
            "packaging",
            ...(hasAutoDeploy ? ["publishing"] : []),
            "cleanup",
          ];

    for (const phase of phases) {
      if (await ctx.isCancelled()) throw new Error("cancelled");
      await ctx.step(phase, "running");
      await ctx.log(`[${phase}] starting…`);
      const lines = phaseLines(phase, ctx.build.target);
      for (const ln of lines) {
        if (await ctx.isCancelled()) throw new Error("cancelled");
        await delay(140);
        await ctx.log(ln);
      }
      await ctx.log(`[${phase}] done`);
      await ctx.step(phase, "success", 0);
    }

    const artifacts =
      ctx.build.target === "android"
        ? [
            { kind: "apk", url: `https://example.invalid/${ctx.build.id}/app-release.apk` },
            { kind: "aab", url: `https://example.invalid/${ctx.build.id}/app-release.aab` },
          ]
        : ctx.build.target === "ios"
          ? [
              { kind: "ipa", url: `https://example.invalid/${ctx.build.id}/app.ipa` },
              { kind: "dsym", url: `https://example.invalid/${ctx.build.id}/app.dSYM.zip` },
            ]
          : [{ kind: "web", url: `https://example.invalid/${ctx.build.id}/web.zip` }];
    return { artifacts };
  }
}

function phaseLines(phase: string, target: string): string[] {
  const base: Record<string, string[]> = {
    preparing: [
      "$ git clone --depth 1 ...",
      "Cloning repository...",
      "Receiving objects: 100% (124/124), done.",
      "Resolving deltas: 100% (32/32), done.",
    ],
    installing: ["$ npm ci", "added 1234 packages in 12s"],
    building:
      target === "ios"
        ? ["$ xcodebuild -workspace App.xcworkspace -scheme App archive", "** ARCHIVE SUCCEEDED **"]
        : target === "android"
          ? ["$ gradle bundleRelease", "BUILD SUCCESSFUL in 1m 14s"]
          : ["$ npm run build", "Built static bundle (1.2 MB)"],
    signing: target === "ios" ? ["$ codesign ...", "Signed with Apple Distribution"] : ["$ apksigner sign ...", "Signed APK"],
    packaging: target === "ios" ? ["$ xcodebuild -exportArchive", "Exported app.ipa"] : ["Bundling artifacts..."],
    publishing: ["Uploading artifacts...", "Done"],
    cleanup: ["Removing temp files..."],
  };
  return base[phase] ?? [];
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
