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
    { id: "android-default", platform: "android" as const, label: "raidx-android-builder", image: "raidx-android-builder:latest", isDefault: true, sortOrder: 0 },
    { id: "web-default", platform: "web" as const, label: "raidx-web-builder", image: "node:20-alpine", isDefault: true, sortOrder: 0 },
    { id: "ios-default", platform: "ios" as const, label: "raidx-ios-builder", image: "/Applications/Xcode.app", isDefault: true, sortOrder: 0 },
  ];
  for (const s of stacks) {
    await db
      .insert(buildStacks)
      .values(s)
      .onConflictDoUpdate({
        target: buildStacks.id,
        set: { platform: s.platform, label: s.label, image: s.image, isDefault: s.isDefault, sortOrder: s.sortOrder },
      });
  }
  console.log(`Seeded ${stacks.length} build stacks`);

  await seedSuperadmin();
  await seedTesterClient();
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

async function seedTesterClient() {
  if (!env.TESTERCLIENT_EMAIL) {
    console.log("TESTERCLIENT_EMAIL not set — skipping tester client seed");
    return;
  }
  const email = env.TESTERCLIENT_EMAIL;

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  let userId: string;
  if (existing) {
    userId = existing.id;
    console.log(`Tester client ${email} already exists`);
  } else {
    const passwordHash = await hashPassword(env.TESTERCLIENT_PASSWORD);
    const [created] = await db
      .insert(users)
      .values({ email, name: "Tester Client", passwordHash, isSuperadmin: false })
      .returning();
    if (!created) throw new Error("Failed to create tester client user");
    userId = created.id;
    console.log(`Created tester client ${email} (password from TESTERCLIENT_PASSWORD)`);
  }

  const slug = "tester-client";
  let [clientOrg] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  if (!clientOrg) {
    [clientOrg] = await db
      .insert(organizations)
      .values({ name: "Tester Client", slug, ownerUserId: userId })
      .returning();
    if (!clientOrg) throw new Error("Failed to create tester client org");
    console.log(`Created tester client org "${slug}"`);
  }

  await db
    .insert(orgMembers)
    .values({ orgId: clientOrg.id, userId, role: "owner" })
    .onConflictDoNothing();

  await db
    .insert(subscriptions)
    .values({ orgId: clientOrg.id, planId: "bohio", status: "active" })
    .onConflictDoNothing({ target: subscriptions.orgId });
  console.log(`Tester client org subscribed`);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
