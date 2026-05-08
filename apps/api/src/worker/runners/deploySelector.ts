import type { StoreDestination } from "../../db/schema.js";
import type { DeployRunner } from "../deployRunner.js";
import { AppStoreUploadRunner } from "./appStoreRunner.js";
import { GooglePlayUploadRunner } from "./googlePlayRunner.js";
import { resolveLinuxHost, resolveMacHost } from "../ssh.js";

/**
 * StubDeployRunner mirrors the existing "fake progress" behaviour, used
 * whenever the destination's required infrastructure (Mac for iOS) isn't
 * configured — so demos still work end-to-end.
 */
class StubDeployRunner implements DeployRunner {
  async run(ctx: import("../deployRunner.js").DeployContext): Promise<void> {
    await ctx.log("Stub deploy runner — replace with the real runner once infrastructure is configured.");
    await new Promise((r) => setTimeout(r, 600));
    await ctx.log(`Pretending to upload build ${ctx.build.id.slice(0, 8)} to ${ctx.destination.name} (${ctx.destination.type}).`);
    await new Promise((r) => setTimeout(r, 1200));
    await ctx.log("Done.");
  }
}

export async function pickDeployRunner(destination: StoreDestination): Promise<DeployRunner> {
  switch (destination.type) {
    case "app_store":
    case "testflight": {
      const mac = await resolveMacHost();
      if (mac) return new AppStoreUploadRunner();
      return new StubDeployRunner();
    }
    case "play_store":
    case "play_internal": {
      // Google Play upload is pure HTTP, no host required — but the artifact
      // download URL must be reachable from this API process. If we have no
      // Linux host configured at all we likely don't have any android builds
      // worth deploying yet, so fall back to stub.
      const linux = await resolveLinuxHost();
      if (linux) return new GooglePlayUploadRunner();
      return new StubDeployRunner();
    }
    default:
      return new StubDeployRunner();
  }
}
