import { db } from "./client.js";
import { buildStacks, plans } from "./schema.js";

const seedPlans = [
  { id: "naboria", name: "Naboria", priceCents: 0, maxApps: 0, maxSeats: 1, maxConcurrentBuilds: 0, canBuild: false, isInternal: false, sortOrder: 0 },
  { id: "bohio", name: "Bohío", priceCents: 999, maxApps: 1, maxSeats: 1, maxConcurrentBuilds: 1, canBuild: true, isInternal: false, sortOrder: 1 },
  { id: "yucayeque", name: "Yucayeque", priceCents: 1499, maxApps: 2, maxSeats: 1, maxConcurrentBuilds: 2, canBuild: true, isInternal: false, sortOrder: 2 },
  { id: "cacique", name: "Cacique", priceCents: 2499, maxApps: 6, maxSeats: 6, maxConcurrentBuilds: 3, canBuild: true, isInternal: false, sortOrder: 3 },
  { id: "unlimited", name: "Unlimited (internal)", priceCents: 0, maxApps: null, maxSeats: null, maxConcurrentBuilds: null, canBuild: true, isInternal: true, sortOrder: 99 },
] as const;

export async function seed() {
  for (const p of seedPlans) {
    await db
      .insert(plans)
      .values(p as never)
      .onConflictDoUpdate({
        target: plans.id,
        set: {
          name: p.name,
          priceCents: p.priceCents,
          maxApps: p.maxApps,
          maxSeats: p.maxSeats,
          maxConcurrentBuilds: p.maxConcurrentBuilds,
          canBuild: p.canBuild,
          isInternal: p.isInternal,
          sortOrder: p.sortOrder,
        },
      });
  }
  console.log(`Seeded ${seedPlans.length} plans`);

  const stacks = [
    { id: "android-default", platform: "android" as const, label: "Android (default)", imageOrXcodeVersion: "raidx-android-builder:latest", isDefault: true, sortOrder: 0 },
    { id: "web-default", platform: "web" as const, label: "Web (Node 20)", imageOrXcodeVersion: "node:20-alpine", isDefault: true, sortOrder: 0 },
    { id: "ios-15", platform: "ios" as const, label: "iOS — Xcode 15", imageOrXcodeVersion: "xcode-15", isDefault: true, sortOrder: 0 },
    { id: "ios-16", platform: "ios" as const, label: "iOS — Xcode 16", imageOrXcodeVersion: "xcode-16", isDefault: false, sortOrder: 1 },
  ];
  for (const s of stacks) {
    await db
      .insert(buildStacks)
      .values(s)
      .onConflictDoUpdate({
        target: buildStacks.id,
        set: { platform: s.platform, label: s.label, imageOrXcodeVersion: s.imageOrXcodeVersion, isDefault: s.isDefault, sortOrder: s.sortOrder },
      });
  }
  console.log(`Seeded ${stacks.length} build stacks`);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
