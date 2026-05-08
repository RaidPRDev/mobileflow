import type { FastifyInstance } from "fastify";
import { count, eq, isNull, and, inArray } from "drizzle-orm";
import { z } from "zod";
import type Stripe from "stripe";
import { db } from "../db/client.js";
import { apps, builds, organizations, plans, subscriptions } from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { env } from "../env.js";
import { getStripe, planForPriceId, priceIdForPlan } from "../billing/stripe.js";

export async function billingRoutes(server: FastifyInstance) {
  server.addHook("preHandler", requireUser);

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId/subscription", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, req.params.orgId)).limit(1);
    return sub ?? null;
  });

  server.get("/billing/plans", async () => {
    const rows = await db.select().from(plans).orderBy(plans.sortOrder);
    return rows
      .filter((p) => !p.isInternal)
      .map((p) => ({
        id: p.id,
        name: p.name,
        priceCents: p.priceCents,
        currency: p.currency,
        maxApps: p.maxApps,
        maxSeats: p.maxSeats,
        maxConcurrentBuilds: p.maxConcurrentBuilds,
        canBuild: p.canBuild,
        hasStripePrice: !!priceIdForPlan(p.id),
      }));
  });

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId/usage", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const [appsCount] = await db.select({ n: count() }).from(apps).where(and(eq(apps.orgId, req.params.orgId), isNull(apps.deletedAt)));
    const orgApps = await db.select({ id: apps.id }).from(apps).where(and(eq(apps.orgId, req.params.orgId), isNull(apps.deletedAt)));
    let inFlight = 0;
    if (orgApps.length > 0) {
      const [c] = await db
        .select({ n: count() })
        .from(builds)
        .where(and(inArray(builds.appId, orgApps.map((a) => a.id)), inArray(builds.status, ["queued", "running"] as const)));
      inFlight = c?.n ?? 0;
    }
    return { apps: appsCount?.n ?? 0, runningOrQueued: inFlight };
  });

  server.post<{ Params: { orgId: string } }>("/orgs/:orgId/billing/checkout", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const stripe = getStripe();
    if (!stripe) return reply.notImplemented("Billing is not configured");
    const body = z.object({ planId: z.enum(["bohio", "yucayeque", "cacique"]) }).parse(req.body);
    const priceId = priceIdForPlan(body.planId);
    if (!priceId) return reply.badRequest(`No Stripe price configured for plan ${body.planId}`);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, req.params.orgId)).limit(1);
    if (!org) return reply.notFound();
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, org.id)).limit(1);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${env.WEB_BASE_URL}/org/${org.id}/settings/subscriptions?checkout=success`,
      cancel_url: `${env.WEB_BASE_URL}/org/${org.id}/settings/subscriptions?checkout=cancel`,
      customer: sub?.stripeCustomerId ?? undefined,
      client_reference_id: org.id,
      metadata: { orgId: org.id, planId: body.planId },
      allow_promotion_codes: true,
    });
    return { url: session.url };
  });

  server.post<{ Params: { orgId: string } }>("/orgs/:orgId/billing/portal", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const stripe = getStripe();
    if (!stripe) return reply.notImplemented("Billing is not configured");
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, req.params.orgId)).limit(1);
    if (!sub?.stripeCustomerId) return reply.badRequest("No Stripe customer for this org yet");
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${env.WEB_BASE_URL}/org/${req.params.orgId}/settings/subscriptions`,
    });
    return { url: session.url };
  });
}

/**
 * The webhook needs the raw request body to verify Stripe's signature, so it's
 * registered separately *outside* the JSON-parser scope.
 */
export async function billingWebhookRoutes(server: FastifyInstance) {
  server.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  server.post("/billing/webhook", async (req, reply) => {
    const stripe = getStripe();
    if (!stripe || !env.STRIPE_WEBHOOK_SECRET) return reply.notImplemented("Billing is not configured");
    const sig = req.headers["stripe-signature"];
    if (!sig || Array.isArray(sig)) return reply.badRequest("Missing stripe-signature header");
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, sig, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      server.log.warn({ err }, "stripe webhook signature verification failed");
      return reply.badRequest("Invalid signature");
    }

    try {
      await handleEvent(event);
    } catch (err) {
      server.log.error({ err, type: event.type }, "stripe webhook handler failed");
      return reply.internalServerError("handler error");
    }
    return { received: true };
  });
}

async function handleEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orgId = session.client_reference_id ?? session.metadata?.orgId;
      const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subscription =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (!orgId) return;
      const planFromMeta = session.metadata?.planId ?? null;
      await upsertSubscription(orgId, {
        planId: (planFromMeta as "bohio" | "yucayeque" | "cacique") ?? null,
        stripeCustomerId: customer ?? null,
        stripeSubscriptionId: subscription ?? null,
        status: "active",
      });
      return;
    }
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.orgId ?? (await orgIdByStripeCustomer(typeof sub.customer === "string" ? sub.customer : sub.customer.id));
      if (!orgId) return;
      const priceId = sub.items.data[0]?.price.id;
      const planId = priceId ? planForPriceId(priceId) : null;
      await upsertSubscription(orgId, {
        planId: (planId as "bohio" | "yucayeque" | "cacique") ?? null,
        stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        stripeSubscriptionId: sub.id,
        status: mapStatus(sub.status),
        currentPeriodStart: new Date(sub.current_period_start * 1000),
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      });
      return;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const orgId = sub.metadata?.orgId ?? (await orgIdByStripeCustomer(typeof sub.customer === "string" ? sub.customer : sub.customer.id));
      if (!orgId) return;
      // Downgrade to the free plan.
      await db
        .insert(subscriptions)
        .values({ orgId, planId: "naboria", status: "active" })
        .onConflictDoUpdate({
          target: subscriptions.orgId,
          set: { planId: "naboria", status: "active", stripeSubscriptionId: null, cancelAtPeriodEnd: false },
        });
      return;
    }
    default:
      return;
  }
}

function mapStatus(s: Stripe.Subscription.Status): "active" | "trialing" | "past_due" | "canceled" {
  if (s === "active" || s === "trialing" || s === "past_due" || s === "canceled") return s;
  if (s === "unpaid" || s === "incomplete_expired") return "past_due";
  return "active";
}

async function orgIdByStripeCustomer(customerId: string): Promise<string | null> {
  const [row] = await db.select({ orgId: subscriptions.orgId }).from(subscriptions).where(eq(subscriptions.stripeCustomerId, customerId)).limit(1);
  return row?.orgId ?? null;
}

async function upsertSubscription(
  orgId: string,
  patch: {
    planId: "bohio" | "yucayeque" | "cacique" | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    status: "active" | "trialing" | "past_due" | "canceled";
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
    cancelAtPeriodEnd?: boolean;
  },
) {
  // We never touch internal `unlimited` plans from webhooks.
  const [existing] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).limit(1);
  if (existing?.planId === "unlimited") return;

  const planId = patch.planId ?? existing?.planId ?? "naboria";
  await db
    .insert(subscriptions)
    .values({
      orgId,
      planId,
      status: patch.status,
      stripeCustomerId: patch.stripeCustomerId ?? null,
      stripeSubscriptionId: patch.stripeSubscriptionId ?? null,
      currentPeriodStart: patch.currentPeriodStart ?? null,
      currentPeriodEnd: patch.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? false,
    })
    .onConflictDoUpdate({
      target: subscriptions.orgId,
      set: {
        planId,
        status: patch.status,
        stripeCustomerId: patch.stripeCustomerId ?? existing?.stripeCustomerId ?? null,
        stripeSubscriptionId: patch.stripeSubscriptionId ?? existing?.stripeSubscriptionId ?? null,
        currentPeriodStart: patch.currentPeriodStart ?? existing?.currentPeriodStart ?? null,
        currentPeriodEnd: patch.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? existing?.cancelAtPeriodEnd ?? false,
      },
    });
}
