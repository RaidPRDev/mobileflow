import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { count, desc, eq, isNull, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  apps,
  billingInfo,
  builds,
  companyInfo,
  organizations,
  orgMembers,
  payments,
  plans,
  subscriptions,
  users,
} from "../db/schema.js";
import { requireOrgMember, requireUser } from "../auth/middleware.js";
import { env } from "../env.js";
import { getActiveAdapter } from "../billing/adapters/registry.js";
import { signVaultReturnState, verifyVaultReturnState } from "../billing/vaultReturnState.js";
import type { NormalizedWebhookEvent, PaymentAdapter } from "../billing/adapters/base.js";
import {
  renderInvoicePdf,
  renderReceiptPdf,
  type PaymentSnapshot,
  type Seller,
} from "../billing/pdf.js";

// Ensure the org has a processor-side customer id, creating one if needed.
// Returns null when no payment processor is configured at all.
async function ensureProcessorCustomer(
  adapter: PaymentAdapter,
  orgId: string,
): Promise<string | null> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .limit(1);
  // Only reuse the cached customer id when it was created with the same
  // provider. Switching processors (e.g. Stripe → ConnectPay) invalidates the
  // old id and we need to mint a fresh one.
  if (sub?.processorCustomerId && sub.paymentProvider === adapter.id) {
    return sub.processorCustomerId;
  }
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) return null;
  const customerId = await adapter.createCustomer({
    orgId,
    name: org.name,
    email: org.billingEmail,
  });
  await db
    .insert(subscriptions)
    .values({
      orgId,
      planId: "naboria",
      status: "active",
      paymentProvider: adapter.id,
      processorCustomerId: customerId,
    })
    .onConflictDoUpdate({
      target: subscriptions.orgId,
      set: { paymentProvider: adapter.id, processorCustomerId: customerId },
    });
  return customerId;
}

const BillingInfoBody = z
  .object({
    fullName: z.string().max(120).nullable().optional(),
    country: z.string().max(2).nullable().optional(),
    addressLine1: z.string().max(200).nullable().optional(),
    addressLine2: z.string().max(200).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    state: z.string().max(120).nullable().optional(),
    postalCode: z.string().max(40).nullable().optional(),
    taxIdType: z.string().max(40).nullable().optional(),
    taxIdValue: z.string().max(80).nullable().optional(),
  })
  .strict();

export async function billingRoutes(server: FastifyInstance) {
  // Hosted-vault return routes authenticate via a signed state token in the
  // query string, since the user arrives via a top-level redirect from the
  // processor (PayPal/ConnectPay) and won't carry the session cookie scoped
  // to the SPA origin. All other billing routes require a user session.
  server.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (
      path === "/api/billing/paypal-vault/return" ||
      path === "/api/billing/connectpay-vault/return"
    ) {
      return;
    }
    return requireUser(req, reply);
  });

  // The web app calls this to know which processor to render and which
  // publishable key (if any) to load. Returns `null` when no processor is
  // active — the UI shows a "Billing not configured" message.
  server.get("/billing/config", async () => {
    const adapter = await getActiveAdapter();
    if (!adapter) return null;
    return adapter.publicBillingConfig();
  });

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId/billing-info", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const [row] = await db
      .select()
      .from(billingInfo)
      .where(eq(billingInfo.orgId, req.params.orgId))
      .limit(1);
    return row ?? null;
  });

  server.put<{ Params: { orgId: string } }>("/orgs/:orgId/billing-info", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const body = BillingInfoBody.parse(req.body);
    const [row] = await db
      .insert(billingInfo)
      .values({ orgId: req.params.orgId, ...body, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: billingInfo.orgId,
        set: { ...body, updatedAt: new Date() },
      })
      .returning();

    // Mirror to the processor's customer record when one exists. Best-effort:
    // a processor outage shouldn't block saving billing info locally.
    const adapter = await getActiveAdapter();
    if (adapter) {
      const customerId = await ensureProcessorCustomer(adapter, req.params.orgId);
      if (customerId) {
        try {
          await adapter.updateCustomer(customerId, {
            name: body.fullName ?? null,
            address: {
              country: body.country ?? null,
              line1: body.addressLine1 ?? null,
              line2: body.addressLine2 ?? null,
              city: body.city ?? null,
              state: body.state ?? null,
              postalCode: body.postalCode ?? null,
            },
          });
        } catch (err) {
          server.log.warn({ err }, "processor updateCustomer failed");
        }
      }
    }
    return row;
  });

  server.post<{ Params: { orgId: string } }>(
    "/orgs/:orgId/billing/setup-intent",
    async (req, reply) => {
      await requireOrgMember(req, reply, req.params.orgId);
      if (reply.sent) return;
      const adapter = await getActiveAdapter();
      if (!adapter) return reply.notImplemented("Billing is not configured");
      const customerId = await ensureProcessorCustomer(adapter, req.params.orgId);
      if (!customerId) return reply.internalServerError("Could not create payment customer");
      // Hosted-vault adapters (PayPal, ConnectPay) bounce back here after the
      // user approves; Stripe ignores these. We point at the API so the
      // exchange happens before the user lands on the web app. The return
      // path is processor-scoped so each adapter parses its own query shape.
      const state = signVaultReturnState(req.params.orgId, req.auth!.userId);
      const successUrl = `${env.API_BASE_URL}/api/billing/${adapter.id}-vault/return?orgId=${encodeURIComponent(req.params.orgId)}&state=${encodeURIComponent(state)}`;
      const cancelUrl = `${env.WEB_BASE_URL}/org/${req.params.orgId}/settings/subscriptions?vault=cancel`;
      return adapter.createSetupIntent(customerId, { successUrl, cancelUrl });
    },
  );

  server.get<{ Params: { orgId: string } }>(
    "/orgs/:orgId/billing/payment-method",
    async (req, reply) => {
      await requireOrgMember(req, reply, req.params.orgId);
      if (reply.sent) return;
      const adapter = await getActiveAdapter();
      if (!adapter) return null;
      const [sub] = await db
        .select({
          provider: subscriptions.paymentProvider,
          customer: subscriptions.processorCustomerId,
          subscriptionId: subscriptions.processorSubscriptionId,
          metadata: subscriptions.metadata,
        })
        .from(subscriptions)
        .where(eq(subscriptions.orgId, req.params.orgId))
        .limit(1);
      if (!sub?.customer || sub.provider !== adapter.id) return null;
      const vaultTokenId =
        (sub.metadata as Record<string, unknown> | null)?.[`${adapter.id}VaultTokenId`];
      return adapter.getDefaultPaymentMethod(sub.customer, {
        subscriptionId: sub.subscriptionId,
        vaultTokenId: typeof vaultTokenId === "string" ? vaultTokenId : null,
      });
    },
  );

  server.post<{
    Params: { orgId: string };
    Body: { paymentMethodId: string };
  }>("/orgs/:orgId/billing/payment-method", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const adapter = await getActiveAdapter();
    if (!adapter) return reply.notImplemented("Billing is not configured");
    const body = z.object({ paymentMethodId: z.string().min(1) }).parse(req.body);
    const customerId = await ensureProcessorCustomer(adapter, req.params.orgId);
    if (!customerId) return reply.internalServerError("Could not create payment customer");
    await adapter.attachPaymentMethod(customerId, body.paymentMethodId);
    return { ok: true };
  });

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId/payments", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.orgId, req.params.orgId))
      .orderBy(desc(payments.createdAt));
    return rows;
  });

  // Single payment with all snapshot fields — drives the hosted invoice page
  // and is the source of truth for the two PDF renderers below.
  server.get<{ Params: { orgId: string; paymentId: string } }>(
    "/orgs/:orgId/payments/:paymentId",
    async (req, reply) => {
      await requireOrgMember(req, reply, req.params.orgId);
      if (reply.sent) return;
      const [row] = await db
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.id, req.params.paymentId),
            eq(payments.orgId, req.params.orgId),
          ),
        )
        .limit(1);
      if (!row) return reply.notFound();
      return row;
    },
  );

  // PDF streaming endpoints. They share the same lookup + snapshot mapping;
  // only the renderer differs. Filenames embed the processor invoice id so
  // browsers default to a recognizable "invoice-PYK….pdf" rather than a uuid.
  const streamPdf = async (
    req: import("fastify").FastifyRequest<{ Params: { orgId: string; paymentId: string } }>,
    reply: import("fastify").FastifyReply,
    kind: "invoice" | "receipt",
  ) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const [row] = await db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.id, req.params.paymentId),
          eq(payments.orgId, req.params.orgId),
        ),
      )
      .limit(1);
    if (!row) return reply.notFound();

    const snapshot: PaymentSnapshot = {
      id: row.id,
      processorInvoiceId: row.processorInvoiceId,
      receiptNumber: row.receiptNumber,
      amountCents: row.amountCents,
      currency: row.currency,
      status: row.status,
      paidAt: row.paidAt,
      createdAt: row.createdAt,
      customerName: row.customerName,
      customerEmail: row.customerEmail,
      customerAddressLine1: row.customerAddressLine1,
      customerAddressLine2: row.customerAddressLine2,
      customerCity: row.customerCity,
      customerState: row.customerState,
      customerPostalCode: row.customerPostalCode,
      customerCountry: row.customerCountry,
      planName: row.planName,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      paymentMethodType: row.paymentMethodType,
      paymentMethodBrand: row.paymentMethodBrand,
      paymentMethodLast4: row.paymentMethodLast4,
    };

    // Brand identity (seller block + logo) is pulled at render time from the
    // company_info singleton. PDFs always reflect the current brand —
    // historical invoices show whoever's "MobileFlow today" is, not whoever
    // it was when the payment first cleared. (If you ever rebrand and want
    // frozen seller info, snapshot it onto the payment row too.)
    const [company] = await db
      .select()
      .from(companyInfo)
      .where(eq(companyInfo.id, 1))
      .limit(1);
    const seller: Seller | null = company
      ? {
          name: company.name ?? "",
          legalName: company.legalName ?? null,
          supportEmail: company.supportEmail ?? null,
          logo:
            company.logoMime && company.logoData
              ? { mime: company.logoMime, data: company.logoData }
              : null,
        }
      : null;

    reply.header("Content-Type", "application/pdf");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${kind}-${row.processorInvoiceId}.pdf"`,
    );
    // pdfkit pipes chunks as the document is built; Fastify's raw response
    // streams them straight to the client without buffering the whole PDF.
    if (kind === "invoice") {
      renderInvoicePdf(snapshot, seller, reply.raw);
    } else {
      renderReceiptPdf(snapshot, seller, reply.raw);
    }
    return reply;
  };

  server.get<{ Params: { orgId: string; paymentId: string } }>(
    "/orgs/:orgId/payments/:paymentId/invoice.pdf",
    (req, reply) => streamPdf(req, reply, "invoice"),
  );
  server.get<{ Params: { orgId: string; paymentId: string } }>(
    "/orgs/:orgId/payments/:paymentId/receipt.pdf",
    (req, reply) => streamPdf(req, reply, "receipt"),
  );

  server.get<{ Params: { orgId: string } }>("/orgs/:orgId/subscription", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, req.params.orgId)).limit(1);
    return sub ?? null;
  });

  server.get("/billing/plans", async () => {
    const adapter = await getActiveAdapter();
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
        hasStripePrice: adapter ? !!adapter.priceIdForPlan(p.id) : false,
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
    const adapter = await getActiveAdapter();
    if (!adapter) return reply.notImplemented("Billing is not configured");
    const body = z.object({ planId: z.enum(["bohio", "yucayeque", "cacique"]) }).parse(req.body);
    if (!adapter.priceIdForPlan(body.planId)) {
      return reply.badRequest(`No price configured for plan ${body.planId} in ${adapter.mode} mode`);
    }
    const [org] = await db.select().from(organizations).where(eq(organizations.id, req.params.orgId)).limit(1);
    if (!org) return reply.notFound();
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, org.id)).limit(1);
    const customerId =
      sub?.processorCustomerId && sub.paymentProvider === adapter.id
        ? sub.processorCustomerId
        : null;
    return adapter.createCheckoutSession({
      orgId: org.id,
      planId: body.planId,
      customerId,
      successUrl: `${env.WEB_BASE_URL}/org/${org.id}/settings/subscriptions?checkout=success`,
      cancelUrl: `${env.WEB_BASE_URL}/org/${org.id}/settings/subscriptions?checkout=cancel`,
    });
  });

  // Hosted-vault bounce-back URL the user lands on after approving a card on
  // PayPal or ConnectPay's hosted page. We attach the saved payment method to
  // the org's processor customer, then redirect to the subscriptions page
  // with a `vault=success|failed` flag the UI can read.
  //
  // The token/id parameter name differs per processor:
  //   - PayPal echoes `approval_token_id` (the v3 setup-token id).
  //   - ConnectPay echoes `payment_method_id` (the vaulted card id).
  const handleVaultReturn = async (
    expectedProvider: "paypal" | "connectpay",
    orgId: string | undefined,
    paymentMethodId: string | undefined,
    state: string | undefined,
    reply: import("fastify").FastifyReply,
    _req: import("fastify").FastifyRequest,
  ) => {
    const subsUrl = (status: "success" | "failed") =>
      `${env.WEB_BASE_URL}/org/${encodeURIComponent(orgId ?? "")}/settings/subscriptions?vault=${status}`;
    if (!orgId || !paymentMethodId) return reply.redirect(subsUrl("failed"));
    // Verify the signed state token threaded through the processor redirect.
    // The user has no session cookie at this origin, so the token is what
    // proves they initiated the flow and which org/user it's for.
    const verified = verifyVaultReturnState(state);
    if (!verified || verified.orgId !== orgId) return reply.redirect(subsUrl("failed"));
    const [u] = await db
      .select({ id: users.id, isSuperadmin: users.isSuperadmin })
      .from(users)
      .where(eq(users.id, verified.userId))
      .limit(1);
    if (!u) return reply.redirect(subsUrl("failed"));
    if (!u.isSuperadmin) {
      const [m] = await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, u.id)))
        .limit(1);
      if (!m) return reply.redirect(subsUrl("failed"));
    }
    const adapter = await getActiveAdapter();
    if (!adapter || adapter.id !== expectedProvider) return reply.redirect(subsUrl("failed"));
    const customerId = await ensureProcessorCustomer(adapter, orgId);
    if (!customerId) return reply.redirect(subsUrl("failed"));
    let attachResult: { customerId: string | null; vaultTokenId: string | null };
    try {
      attachResult = await adapter.attachPaymentMethod(customerId, paymentMethodId);
    } catch (err) {
      server.log.warn({ err, orgId, provider: expectedProvider }, "vault exchange failed");
      return reply.redirect(subsUrl("failed"));
    }
    // Persist any updates the adapter surfaced:
    //   - `customerId`: a fresh processor-side customer ID — PayPal returns
    //     the real customer.id after the first vault attach on an org that
    //     only had a synthetic placeholder.
    //   - `vaultTokenId`: the hosted-vault payment-token id. Stored on
    //     subscriptions.metadata so free-tier orgs (no subscription yet) can
    //     still surface their saved payment method in the UI.
    const updates: { processorCustomerId?: string; metadata?: Record<string, unknown> } = {};
    if (attachResult.customerId && attachResult.customerId !== customerId) {
      updates.processorCustomerId = attachResult.customerId;
    }
    if (attachResult.vaultTokenId) {
      const [existing] = await db
        .select({ metadata: subscriptions.metadata })
        .from(subscriptions)
        .where(eq(subscriptions.orgId, orgId))
        .limit(1);
      updates.metadata = {
        ...(existing?.metadata ?? {}),
        [`${expectedProvider}VaultTokenId`]: attachResult.vaultTokenId,
      };
    }
    if (Object.keys(updates).length > 0) {
      await db.update(subscriptions).set(updates).where(eq(subscriptions.orgId, orgId));
    }
    return reply.redirect(subsUrl("success"));
  };

  server.get<{
    Querystring: {
      orgId?: string;
      approval_token_id?: string;
      approval_session_id?: string;
      state?: string;
    };
  }>("/billing/paypal-vault/return", async (req, reply) => {
    return handleVaultReturn(
      "paypal",
      req.query.orgId,
      req.query.approval_token_id,
      req.query.state,
      reply,
      req,
    );
  });

  server.get<{
    Querystring: {
      orgId?: string;
      payment_method_id?: string;
      session_id?: string;
      status?: string;
      state?: string;
    };
  }>("/billing/connectpay-vault/return", async (req, reply) => {
    const orgId = req.query.orgId;
    const subsUrl = (status: "success" | "failed" | "cancel") =>
      `${env.WEB_BASE_URL}/org/${encodeURIComponent(orgId ?? "")}/settings/subscriptions?vault=${status}`;
    if (req.query.status === "cancel") return reply.redirect(subsUrl("cancel"));
    return handleVaultReturn(
      "connectpay",
      orgId,
      req.query.payment_method_id,
      req.query.state,
      reply,
      req,
    );
  });

  server.post<{ Params: { orgId: string } }>("/orgs/:orgId/billing/portal", async (req, reply) => {
    await requireOrgMember(req, reply, req.params.orgId);
    if (reply.sent) return;
    const adapter = await getActiveAdapter();
    if (!adapter) return reply.notImplemented("Billing is not configured");
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, req.params.orgId)).limit(1);
    if (!sub?.processorCustomerId || sub.paymentProvider !== adapter.id) {
      return reply.badRequest("No payment customer for this org yet");
    }
    return adapter.createBillingPortal(
      sub.processorCustomerId,
      `${env.WEB_BASE_URL}/org/${req.params.orgId}/settings/subscriptions`,
    );
  });
}

// Processor webhooks. The route is /billing/webhook/:provider so each adapter
// only sees its own events, and the public URL stays stable when we add
// processors (admins set the URL once per processor in its dashboard).
export async function billingWebhookRoutes(server: FastifyInstance) {
  server.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  server.post<{ Params: { provider: string } }>(
    "/billing/webhook/:provider",
    async (req, reply) => {
      const adapter = await getActiveAdapter();
      if (!adapter || adapter.id !== req.params.provider) {
        return reply.notImplemented("Webhook provider does not match the active processor");
      }
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const event = await adapter.verifyWebhook(req.body as Buffer, headers);
      if (!event) return reply.badRequest("Invalid webhook signature");
      try {
        await handleNormalizedEvent(adapter, event);
      } catch (err) {
        server.log.error({ err, type: event.type }, "webhook handler failed");
        return reply.internalServerError("handler error");
      }
      return { received: true };
    },
  );
}

async function handleNormalizedEvent(adapter: PaymentAdapter, event: NormalizedWebhookEvent) {
  switch (event.type) {
    case "checkout.completed": {
      const orgId = (event.data.orgId as string | null) ?? null;
      const customerId = (event.data.customerId as string | null) ?? null;
      const subscriptionId = (event.data.subscriptionId as string | null) ?? null;
      const planId = (event.data.planId as "bohio" | "yucayeque" | "cacique" | null) ?? null;
      if (!orgId) return;
      await upsertSubscription(adapter.id, orgId, {
        planId,
        processorCustomerId: customerId,
        processorSubscriptionId: subscriptionId,
        status: "active",
      });
      return;
    }
    case "subscription.upserted": {
      const customerId = event.data.customerId as string | null;
      const orgId =
        (event.data.orgId as string | null) ??
        (customerId ? await orgIdByProcessorCustomer(adapter.id, customerId) : null);
      if (!orgId) return;
      await upsertSubscription(adapter.id, orgId, {
        planId: (event.data.planId as "bohio" | "yucayeque" | "cacique" | null) ?? null,
        processorCustomerId: customerId,
        processorSubscriptionId: (event.data.subscriptionId as string | null) ?? null,
        status: event.data.status as "active" | "trialing" | "past_due" | "canceled",
        currentPeriodStart: event.data.currentPeriodStart
          ? new Date(event.data.currentPeriodStart as string)
          : undefined,
        currentPeriodEnd: event.data.currentPeriodEnd
          ? new Date(event.data.currentPeriodEnd as string)
          : undefined,
        cancelAtPeriodEnd: (event.data.cancelAtPeriodEnd as boolean | undefined) ?? false,
      });
      return;
    }
    case "subscription.deleted": {
      const customerId = event.data.customerId as string | null;
      const orgId =
        (event.data.orgId as string | null) ??
        (customerId ? await orgIdByProcessorCustomer(adapter.id, customerId) : null);
      if (!orgId) return;
      // Downgrade to free.
      await db
        .insert(subscriptions)
        .values({ orgId, planId: "naboria", status: "active" })
        .onConflictDoUpdate({
          target: subscriptions.orgId,
          set: {
            planId: "naboria",
            status: "active",
            processorSubscriptionId: null,
            cancelAtPeriodEnd: false,
          },
        });
      return;
    }
    case "invoice.upserted": {
      const customerId = event.data.customerId as string | null;
      const orgId =
        (event.data.orgId as string | null) ??
        (customerId ? await orgIdByProcessorCustomer(adapter.id, customerId) : null);
      const invoiceId = event.data.invoiceId as string | null;
      if (!orgId || !invoiceId) return;

      const baseValues = {
        orgId,
        paymentProvider: adapter.id,
        processorInvoiceId: invoiceId,
        amountCents: (event.data.amountCents as number | undefined) ?? 0,
        currency: ((event.data.currency as string | undefined) ?? "USD").toUpperCase(),
        status: event.data.status as
          | "paid"
          | "open"
          | "uncollectible"
          | "void"
          | "draft"
          | "failed",
        description: (event.data.description as string | null) ?? null,
        hostedInvoiceUrl: (event.data.hostedInvoiceUrl as string | null) ?? null,
        invoicePdfUrl: (event.data.invoicePdfUrl as string | null) ?? null,
        paidAt: event.data.paidAt ? new Date(event.data.paidAt as string) : null,
      };

      // Snapshot fields are populated only on first insert — invoices are
      // historical records and must not retroactively change when the org
      // renames itself, moves address, or upgrades plan. Re-deliveries of the
      // same event update only mutable fields (status / amount / paidAt).
      const snapshot = await buildInvoiceSnapshot(adapter, orgId);

      await db
        .insert(payments)
        .values({ ...baseValues, ...snapshot })
        .onConflictDoUpdate({
          target: [payments.paymentProvider, payments.processorInvoiceId],
          set: {
            amountCents: baseValues.amountCents,
            currency: baseValues.currency,
            status: baseValues.status,
            description: baseValues.description,
            hostedInvoiceUrl: baseValues.hostedInvoiceUrl,
            invoicePdfUrl: baseValues.invoicePdfUrl,
            paidAt: baseValues.paidAt,
          },
        });
      return;
    }
    case "ignored":
    default:
      return;
  }
}

async function orgIdByProcessorCustomer(
  provider: PaymentAdapter["id"],
  customerId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ orgId: subscriptions.orgId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.paymentProvider, provider),
        eq(subscriptions.processorCustomerId, customerId),
      ),
    )
    .limit(1);
  return row?.orgId ?? null;
}

// Build the snapshot of customer + plan + payment-method values to freeze
// onto a payment row at the time the invoice is first written. Best-effort —
// any missing piece becomes null on the row, which the renderer treats as
// "unknown" rather than blocking the invoice.
async function buildInvoiceSnapshot(adapter: PaymentAdapter, orgId: string) {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const [info] = await db
    .select()
    .from(billingInfo)
    .where(eq(billingInfo.orgId, orgId))
    .limit(1);
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.orgId, orgId))
    .limit(1);
  const [plan] = sub?.planId
    ? await db.select().from(plans).where(eq(plans.id, sub.planId)).limit(1)
    : [undefined];

  let pmType: string | null = null;
  let pmBrand: string | null = null;
  let pmLast4: string | null = null;
  if (sub?.processorCustomerId) {
    try {
      const vaultTokenId =
        (sub.metadata as Record<string, unknown> | null)?.[`${adapter.id}VaultTokenId`];
      const pm = await adapter.getDefaultPaymentMethod(sub.processorCustomerId, {
        subscriptionId: sub.processorSubscriptionId,
        vaultTokenId: typeof vaultTokenId === "string" ? vaultTokenId : null,
      });
      if (pm) {
        pmType = pm.type;
        // `PaymentMethodSummary` is a discriminated union but its non-card
        // variant types `type` as plain `string`, which kills the narrowing
        // via `pm.type === "card"`. Branch on the presence of `brand` instead.
        if ("brand" in pm) {
          pmBrand = pm.brand;
          pmLast4 = pm.last4;
        }
      }
    } catch {
      // Adapter outage shouldn't fail the webhook; leave snapshot fields null.
    }
  }

  return {
    customerName: info?.fullName ?? org?.name ?? null,
    customerEmail: org?.billingEmail ?? null,
    customerAddressLine1: info?.addressLine1 ?? null,
    customerAddressLine2: info?.addressLine2 ?? null,
    customerCity: info?.city ?? null,
    customerState: info?.state ?? null,
    customerPostalCode: info?.postalCode ?? null,
    customerCountry: info?.country ?? null,
    planId: sub?.planId ?? null,
    planName: plan?.name ?? null,
    planPriceCents: plan?.priceCents ?? null,
    periodStart: sub?.currentPeriodStart ?? null,
    periodEnd: sub?.currentPeriodEnd ?? null,
    paymentMethodType: pmType,
    paymentMethodBrand: pmBrand,
    paymentMethodLast4: pmLast4,
    receiptNumber: generateReceiptNumber(),
  };
}

// Receipt numbers are purely for human reference — "1234-5678" style. Using
// crypto.randomInt for collision safety; with two 4-digit halves the odds of
// a clash within an org's history are vanishingly small for any realistic
// usage. (Don't rely on these for uniqueness — payments.id is the real key.)
function generateReceiptNumber(): string {
  const a = String(randomInt(0, 10_000)).padStart(4, "0");
  const b = String(randomInt(0, 10_000)).padStart(4, "0");
  return `${a}-${b}`;
}

async function upsertSubscription(
  provider: PaymentAdapter["id"],
  orgId: string,
  patch: {
    planId: "bohio" | "yucayeque" | "cacique" | null;
    processorCustomerId: string | null;
    processorSubscriptionId: string | null;
    status: "active" | "trialing" | "past_due" | "canceled";
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
    cancelAtPeriodEnd?: boolean;
  },
) {
  // Never overwrite internal unlimited plans via webhook.
  const [existing] = await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).limit(1);
  if (existing?.planId === "unlimited") return;

  const planId = patch.planId ?? existing?.planId ?? "naboria";
  await db
    .insert(subscriptions)
    .values({
      orgId,
      planId,
      status: patch.status,
      paymentProvider: provider,
      processorCustomerId: patch.processorCustomerId ?? null,
      processorSubscriptionId: patch.processorSubscriptionId ?? null,
      currentPeriodStart: patch.currentPeriodStart ?? null,
      currentPeriodEnd: patch.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? false,
    })
    .onConflictDoUpdate({
      target: subscriptions.orgId,
      set: {
        planId,
        status: patch.status,
        paymentProvider: provider,
        processorCustomerId: patch.processorCustomerId ?? existing?.processorCustomerId ?? null,
        processorSubscriptionId:
          patch.processorSubscriptionId ?? existing?.processorSubscriptionId ?? null,
        currentPeriodStart: patch.currentPeriodStart ?? existing?.currentPeriodStart ?? null,
        currentPeriodEnd: patch.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: patch.cancelAtPeriodEnd ?? existing?.cancelAtPeriodEnd ?? false,
      },
    });
}
