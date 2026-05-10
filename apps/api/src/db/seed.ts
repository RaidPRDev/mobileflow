import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { buildStacks, organizations, orgMembers, plans, subscriptions, users } from "./schema.js";
import { hashPassword } from "../auth/password.js";
import { env } from "../env.js";

const ADMIN_ORG_SLUG = "mf-admin";
const ADMIN_ORG_NAME = "MobileFlow Admin";

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

  await seedSuperadmin();
}

async function seedSuperadmin() {
  if (!env.SUPERADMIN_EMAIL) {
    console.log("SUPERADMIN_EMAIL not set — skipping superadmin seed");
    return;
  }
  const email = env.SUPERADMIN_EMAIL;

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let userId: string;
  if (existing) {
    userId = existing.id;
    if (!existing.isSuperadmin) {
      await db.update(users).set({ isSuperadmin: true }).where(eq(users.id, userId));
      console.log(`Promoted existing user ${email} to superadmin`);
    } else {
      console.log(`Superadmin ${email} already exists`);
    }
  } else {
    const passwordHash = await hashPassword(env.SUPERADMIN_PASSWORD);
    const [created] = await db
      .insert(users)
      .values({ email, name: "Super Admin", passwordHash, isSuperadmin: true })
      .returning();
    if (!created) throw new Error("Failed to create superadmin user");
    userId = created.id;
    console.log(`Created superadmin ${email} (password from SUPERADMIN_PASSWORD)`);
  }

  let [adminOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, ADMIN_ORG_SLUG))
    .limit(1);
  if (!adminOrg) {
    [adminOrg] = await db
      .insert(organizations)
      .values({ name: ADMIN_ORG_NAME, slug: ADMIN_ORG_SLUG, ownerUserId: userId })
      .returning();
    if (!adminOrg) throw new Error("Failed to create admin org");
    console.log(`Created admin org "${ADMIN_ORG_SLUG}"`);
  }

  await db
    .insert(orgMembers)
    .values({ orgId: adminOrg.id, userId, role: "owner" })
    .onConflictDoNothing();

  await db
    .insert(subscriptions)
    .values({ orgId: adminOrg.id, planId: "unlimited", status: "active" })
    .onConflictDoUpdate({
      target: subscriptions.orgId,
      set: { planId: "unlimited", status: "active" },
    });
  console.log(`Admin org subscribed to "unlimited" plan`);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
