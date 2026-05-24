import Stripe from "stripe";
import type {
  AdapterFieldSchema,
  CheckoutInput,
  CreateCustomerInput,
  NormalizedWebhookEvent,
  PaymentAdapter,
  PaymentMethodSummary,
  ProcessorMode,
  PublicBillingConfig,
  UpdateCustomerInput,
} from "./base.js";

// Stripe's credential/config blob shape after decryption.
//
// `keys` is keyed by mode so an admin can paste both their test and live
// keys once and flip `mode` without re-entering anything. The Stripe price
// IDs live under `prices` and are also per-mode (Stripe gives different
// price IDs in test vs live mode).
export interface StripeCredentialsBlob {
  keys?: {
    sandbox?: { publishableKey?: string; secretKey?: string; webhookSecret?: string };
    production?: { publishableKey?: string; secretKey?: string; webhookSecret?: string };
  };
}

export interface StripeConfigBlob {
  prices?: {
    sandbox?: { bohio?: string; yucayeque?: string; cacique?: string };
    production?: { bohio?: string; yucayeque?: string; cacique?: string };
  };
}

const CREDS_SCHEMA: AdapterFieldSchema = {
  fields: [
    {
      key: "publishableKey",
      label: "Publishable key",
      type: "string",
      placeholder: "pk_test_… / pk_live_…",
      mode: "per-mode",
      required: true,
    },
    {
      key: "secretKey",
      label: "Secret key",
      type: "secret",
      placeholder: "sk_test_… / sk_live_…",
      mode: "per-mode",
      required: true,
    },
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      type: "secret",
      placeholder: "whsec_…",
      helpText: "From Dashboard → Developers → Webhooks → your endpoint signing secret.",
      mode: "per-mode",
    },
  ],
};

const CONFIG_SCHEMA: AdapterFieldSchema = {
  fields: [
    {
      key: "prices.bohio",
      label: "Price ID — Bohío",
      type: "string",
      placeholder: "price_…",
      mode: "per-mode",
    },
    {
      key: "prices.yucayeque",
      label: "Price ID — Yucayeque",
      type: "string",
      placeholder: "price_…",
      mode: "per-mode",
    },
    {
      key: "prices.cacique",
      label: "Price ID — Cacique",
      type: "string",
      placeholder: "price_…",
      mode: "per-mode",
    },
  ],
};

export class StripeAdapter implements PaymentAdapter {
  readonly id = "stripe" as const;
  readonly displayName = "Stripe";
  readonly mode: ProcessorMode;

  private readonly client: Stripe;
  private readonly publishableKey: string | null;
  private readonly webhookSecret: string | null;
  private readonly prices: { bohio?: string; yucayeque?: string; cacique?: string };

  constructor(mode: ProcessorMode, creds: StripeCredentialsBlob, config: StripeConfigBlob) {
    this.mode = mode;
    const modeCreds = creds.keys?.[mode] ?? {};
    if (!modeCreds.secretKey) {
      throw new Error(`Stripe: no secret key configured for ${mode} mode`);
    }
    this.client = new Stripe(modeCreds.secretKey, { apiVersion: "2024-06-20" });
    this.publishableKey = modeCreds.publishableKey ?? null;
    this.webhookSecret = modeCreds.webhookSecret ?? null;
    this.prices = config.prices?.[mode] ?? {};
  }

  static credentialsSchemaStatic(): AdapterFieldSchema {
    return CREDS_SCHEMA;
  }
  static configSchemaStatic(): AdapterFieldSchema {
    return CONFIG_SCHEMA;
  }

  credentialsSchema(): AdapterFieldSchema {
    return CREDS_SCHEMA;
  }
  configSchema(): AdapterFieldSchema {
    return CONFIG_SCHEMA;
  }

  publicBillingConfig(): PublicBillingConfig {
    return {
      provider: "stripe",
      mode: this.mode,
      publicConfig: {
        publishableKey: this.publishableKey,
      },
    };
  }

  async createCustomer(input: CreateCustomerInput): Promise<string> {
    const customer = await this.client.customers.create({
      name: input.name ?? undefined,
      email: input.email ?? undefined,
      metadata: { orgId: input.orgId },
    });
    return customer.id;
  }

  async updateCustomer(customerId: string, patch: UpdateCustomerInput): Promise<void> {
    await this.client.customers.update(customerId, {
      name: patch.name ?? undefined,
      email: patch.email ?? undefined,
      address: patch.address
        ? {
            country: patch.address.country ?? undefined,
            line1: patch.address.line1 ?? undefined,
            line2: patch.address.line2 ?? undefined,
            city: patch.address.city ?? undefined,
            state: patch.address.state ?? undefined,
            postal_code: patch.address.postalCode ?? undefined,
          }
        : undefined,
    });
  }

  async createSetupIntent(customerId: string): Promise<{ clientSecret: string }> {
    const intent = await this.client.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
    });
    if (!intent.client_secret) throw new Error("Stripe returned a SetupIntent with no client_secret");
    return { clientSecret: intent.client_secret };
  }

  async attachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void> {
    await this.client.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await this.client.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  }

  async getDefaultPaymentMethod(customerId: string): Promise<PaymentMethodSummary | null> {
    const customer = await this.client.customers.retrieve(customerId);
    if (customer.deleted) return null;
    const defaultPmId =
      typeof customer.invoice_settings?.default_payment_method === "string"
        ? customer.invoice_settings.default_payment_method
        : customer.invoice_settings?.default_payment_method?.id ?? null;
    if (!defaultPmId) return null;
    const pm = await this.client.paymentMethods.retrieve(defaultPmId);
    if (pm.type !== "card" || !pm.card) return { type: pm.type };
    return {
      type: "card",
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    };
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string }> {
    const priceId = this.priceIdForPlan(input.planId);
    if (!priceId) {
      throw new Error(`Stripe: no price configured for plan ${input.planId} in ${this.mode} mode`);
    }
    const session = await this.client.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      customer: input.customerId ?? undefined,
      client_reference_id: input.orgId,
      metadata: { orgId: input.orgId, planId: input.planId },
      allow_promotion_codes: true,
    });
    if (!session.url) throw new Error("Stripe returned a Checkout Session with no URL");
    return { url: session.url };
  }

  async createBillingPortal(customerId: string, returnUrl: string): Promise<{ url: string }> {
    const session = await this.client.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  priceIdForPlan(planId: string): string | null {
    switch (planId) {
      case "bohio":
        return this.prices.bohio ?? null;
      case "yucayeque":
        return this.prices.yucayeque ?? null;
      case "cacique":
        return this.prices.cacique ?? null;
      default:
        return null;
    }
  }

  planForPriceId(priceId: string): string | null {
    if (priceId === this.prices.bohio) return "bohio";
    if (priceId === this.prices.yucayeque) return "yucayeque";
    if (priceId === this.prices.cacique) return "cacique";
    return null;
  }

  async verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedWebhookEvent | null> {
    if (!this.webhookSecret) return null;
    const sig = headers["stripe-signature"];
    if (!sig || Array.isArray(sig)) return null;
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, sig, this.webhookSecret);
    } catch {
      return null;
    }
    return this.normalize(event);
  }

  // Map Stripe event → handler-agnostic shape. billing.ts cares about three
  // concrete flows (checkout completed, subscription upserts/deletes, invoice
  // updates) and ignores the rest. Keeping the heavy lifting (price → plan,
  // customer→orgId resolution) here means other adapters can produce the same
  // shape without billing.ts knowing how.
  private normalize(event: Stripe.Event): NormalizedWebhookEvent {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        return {
          id: event.id,
          type: "checkout.completed",
          data: {
            orgId: s.client_reference_id ?? s.metadata?.orgId ?? null,
            customerId: typeof s.customer === "string" ? s.customer : s.customer?.id ?? null,
            subscriptionId:
              typeof s.subscription === "string" ? s.subscription : s.subscription?.id ?? null,
            planId: s.metadata?.planId ?? null,
          },
        };
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const priceId = sub.items.data[0]?.price.id ?? null;
        return {
          id: event.id,
          type: "subscription.upserted",
          data: {
            orgId: sub.metadata?.orgId ?? null,
            customerId,
            subscriptionId: sub.id,
            planId: priceId ? this.planForPriceId(priceId) : null,
            status: mapStatus(sub.status),
            currentPeriodStart: new Date(sub.current_period_start * 1000).toISOString(),
            currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString(),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          },
        };
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        return {
          id: event.id,
          type: "subscription.deleted",
          data: { orgId: sub.metadata?.orgId ?? null, customerId },
        };
      }
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.finalized":
      case "invoice.voided":
      case "invoice.marked_uncollectible": {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
        const status: "paid" | "open" | "uncollectible" | "void" | "draft" | "failed" =
          event.type === "invoice.payment_failed"
            ? "failed"
            : inv.status === "paid" ||
                inv.status === "open" ||
                inv.status === "uncollectible" ||
                inv.status === "void" ||
                inv.status === "draft"
              ? inv.status
              : "open";
        return {
          id: event.id,
          type: "invoice.upserted",
          data: {
            orgId: inv.metadata?.orgId ?? null,
            customerId,
            invoiceId: inv.id ?? null,
            amountCents: inv.amount_due ?? 0,
            currency: (inv.currency ?? "usd").toUpperCase(),
            status,
            description: inv.description ?? inv.lines.data[0]?.description ?? null,
            hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
            invoicePdfUrl: inv.invoice_pdf ?? null,
            paidAt: inv.status_transitions?.paid_at
              ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
              : null,
          },
        };
      }
      default:
        return { id: event.id, type: "ignored", data: {} };
    }
  }
}

function mapStatus(s: Stripe.Subscription.Status): "active" | "trialing" | "past_due" | "canceled" {
  if (s === "active" || s === "trialing" || s === "past_due" || s === "canceled") return s;
  if (s === "unpaid" || s === "incomplete_expired") return "past_due";
  return "active";
}
