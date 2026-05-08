import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { buildHosts } from "../../db/schema.js";
import { env } from "../../env.js";
import type { Runner } from "../runner.js";
import { StubRunner } from "../runner.js";
import { LinuxDockerAndroidRunner } from "./linuxDocker.js";
import { LinuxDockerWebRunner } from "./linuxWeb.js";
import { MacRunner } from "./macRunner.js";

async function hostAvailable(kind: "linux_docker" | "mac"): Promise<boolean> {
  if (kind === "linux_docker" && env.LINUX_BUILD_HOST) return true;
  if (kind === "mac" && env.MAC_BUILD_HOST && env.MAC_BUILD_USER) return true;
  const [row] = await db
    .select({ id: buildHosts.id })
    .from(buildHosts)
    .where(and(eq(buildHosts.kind, kind), eq(buildHosts.online, true)))
    .limit(1);
  return !!row;
}

export async function pickRunner(target: "ios" | "android" | "web"): Promise<Runner> {
  if (target === "android" && (await hostAvailable("linux_docker"))) {
    return new LinuxDockerAndroidRunner();
  }
  if (target === "web" && (await hostAvailable("linux_docker"))) {
    return new LinuxDockerWebRunner();
  }
  if (target === "ios" && (await hostAvailable("mac"))) {
    return new MacRunner();
  }
  return new StubRunner();
}
