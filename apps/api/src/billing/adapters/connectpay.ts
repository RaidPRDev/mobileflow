import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AdapterFieldSchema,
  CheckoutInput,
  CreateCustomerInput,
  NormalizedWebhookEvent,
  PaymentAdapter,
  PaymentMethodSummary,
  ProcessorMode,
  PublicBillingConfig,
  SetupIntentResult,
  UpdateCustomerInput,
} from "./base.js";

// ConnectPay (Puerto Rico) — card processor with a Customer Vault, hosted
// checkout, and recurring-billing plans. The endpoint paths and header names
// here follow the pattern documented in ConnectPay's REST guide; if your
// merchant account uses a different version of the API, adjust the constants
// at the top of the class.
//
// Auth model: every request is signed with HMAC-SHA256 over
// `<timestamp>.<method>.<path>.<body-sha256>` using the merchant's HMAC
// secret. The signature travels in `X-ConnectPay-Signature` alongside the
// API key in `X-ConnectPay-Key`. Webhooks use the same HMAC scheme over
// the raw request body, validated by `verifyWebhook`.

export interface ConnectPayCredentialsBlob {
  keys?: {
    sandbox?: { merchantId?: string; apiKey?: string; hmacSecret?: string };
    production?: { merchantId?: string; apiKey?: string; hmacSecret?: string };
  };
}

export interface ConnectPayConfigBlob {
  plans?: {
    sandbox?: { bohio?: string; yucayeque?: string; cacique?: string };
    production?: { bohio?: string; yucayeque?: string; cacique?: string };
  };
}

const CREDS_SCHEMA: AdapterFieldSchema = {
  fields: [
    {
      key: "merchantId",
      label: "Merchant ID",
      type: "string",
      placeholder: "MID-…",
      mode: "per-mode",
      required: true,
    },
    {
      key: "apiKey",
      label: "API key",
      type: "secret",
      placeholder: "cpk_…",
      mode: "per-mode",
      required: true,
    },
    {
      key: "hmacSecret",
      label: "HMAC signing secret",
      type: "secret",
      placeholder: "whsec_…",
      helpText:
        "Used to sign outbound requests and to verify webhook signatures. Available under Settings → API & Webhooks in the ConnectPay dashboard.",
      mode: "per-mode",
    },
  ],
};

const CONFIG_SCHEMA: AdapterFieldSchema = {
  fields: [
    {
      key: "plans.bohio",
      label: "Plan code — Bohío",
      type: "string",
      placeholder: "plan_…",
      mode: "per-mode",
    },
    {
      key: "plans.yucayeque",
      label: "Plan code — Yucayeque",
      type: "string",
      placeholder: "plan_…",
      mode: "per-mode",
    },
    {
      key: "plans.cacique",
      label: "Plan code — Cacique",
      type: "string",
      placeholder: "plan_…",
      mode: "per-mode",
    },
  ],
};

const SANDBOX_API = "https://sandbox.connectpaypr.com/api/v1";
const LIVE_API = "https://api.connectpaypr.com/v1";

export class ConnectPayAdapter implements PaymentAdapter {
  readonly id = "connectpay" as const;
  readonly displayName = "ConnectPay";
  readonly mode: ProcessorMode;

  private readonly apiBase: string;
  private readonly merchantId: string;
  private readonly apiKey: string;
  private readonly hmacSecret: string | null;
  private readonly plans: { bohio?: string; yucayeque?: string; cacique?: string };

  constructor(
    mode: ProcessorMode,
    creds: ConnectPayCredentialsBlob,
    config: ConnectPayConfigBlob,
  ) {
    this.mode = mode;
    const modeCreds = creds.keys?.[mode] ?? {};
    if (!modeCreds.merchantId || !modeCreds.apiKey) {
      throw new Error(`ConnectPay: merchant id and API key are required for ${mode} mode`);
    }
    this.merchantId = modeCreds.merchantId;
    this.apiKey = modeCreds.apiKey;
    this.hmacSecret = modeCreds.hmacSecret ?? null;
    this.apiBase = mode === "sandbox" ? SANDBOX_API : LIVE_API;
    this.plans = config.plans?.[mode] ?? {};
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
      provider: "connectpay",
      mode: this.mode,
      // ConnectPay's frontend integration is purely redirect-based (hosted
      // iframe / hosted checkout page), so no public key needs to ship to
      // the browser. The merchantId is harmless to expose if a future
      // inline-iframe flow needs it.
      publicConfig: { merchantId: this.merchantId },
    };
  }

  async createCustomer(input: CreateCustomerInput): Promise<string> {
    const res = await this.signedFetch<{ id: string }>("POST", "/customers", {
      external_id: input.orgId,
      name: input.name ?? undefined,
      email: input.email ?? undefined,
    });
    return res.id;
  }

  async updateCustomer(customerId: string, patch: UpdateCustomerInput): Promise<void> {
    await this.signedFetch("PATCH", `/customers/${encodeURIComponent(customerId)}`, {
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

  // Hosted card-vault session. The customer is redirected to ConnectPay,
  // enters card details on their iframe, and the saved card lands in the
  // customer's vault. After completion we get a webhook
  // (`customer.payment_method.created`) and the SPA returns to the org page.
  async createSetupIntent(
    customerId: string,
    urls?: { successUrl: string; cancelUrl: string },
  ): Promise<SetupIntentResult> {
    const res = await this.signedFetch<{ redirect_url: string }>(
      "POST",
      "/checkout/sessions",
      {
        intent: "setup",
        customer_id: customerId,
        return_url: urls?.successUrl ?? "",
        cancel_url: urls?.cancelUrl ?? "",
      },
    );
    return { redirectUrl: res.redirect_url };
  }

  async attachPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<{ customerId: string | null; vaultTokenId: string | null }> {
    await this.signedFetch(
      "POST",
      `/customers/${encodeURIComponent(customerId)}/payment-methods/${encodeURIComponent(
        paymentMethodId,
      )}/default`,
      {},
    );
    return { customerId: null, vaultTokenId: null };
  }

  async getDefaultPaymentMethod(customerId: string): Promise<PaymentMethodSummary | null> {
    const res = await this.signedFetch<{
      default_payment_method?: {
        type?: string;
        card?: {
          brand?: string;
          last4?: string;
          exp_month?: number;
          exp_year?: number;
        };
      } | null;
    }>("GET", `/customers/${encodeURIComponent(customerId)}`);
    const pm = res.default_payment_method;
    if (!pm) return null;
    if (pm.type !== "card" || !pm.card) return { type: pm.type ?? "unknown" };
    return {
      type: "card",
      brand: pm.card.brand ?? "card",
      last4: pm.card.last4 ?? "????",
      expMonth: pm.card.exp_month ?? 0,
      expYear: pm.card.exp_year ?? 0,
    };
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string }> {
    const planCode = this.priceIdForPlan(input.planId);
    if (!planCode) {
      throw new Error(
        `ConnectPay: no plan configured for ${input.planId} in ${this.mode} mode`,
      );
    }
    const res = await this.signedFetch<{ redirect_url: string }>(
      "POST",
      "/checkout/sessions",
      {
        intent: "subscription",
        customer_id: input.customerId ?? undefined,
        external_customer_id: input.orgId,
        plan_code: planCode,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: { orgId: input.orgId, planId: input.planId },
      },
    );
    return { url: res.redirect_url };
  }

  async createBillingPortal(customerId: string, returnUrl: string): Promise<{ url: string }> {
    const res = await this.signedFetch<{ redirect_url: string }>(
      "POST",
      "/customers/portal-sessions",
      { customer_id: customerId, return_url: returnUrl },
    );
    return { url: res.redirect_url };
  }

  priceIdForPlan(planId: string): string | null {
    switch (planId) {
      case "bohio":
        return this.plans.bohio ?? null;
      case "yucayeque":
        return this.plans.yucayeque ?? null;
      case "cacique":
        return this.plans.cacique ?? null;
      default:
        return null;
    }
  }

  planForPriceId(priceId: string): string | null {
    if (priceId === this.plans.bohio) return "bohio";
    if (priceId === this.plans.yucayeque) return "yucayeque";
    if (priceId === this.plans.cacique) return "cacique";
    return null;
  }

  async verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedWebhookEvent | null> {
    if (!this.hmacSecret) return null;
    const get = (k: string): string | null => {
      const v = headers[k] ?? headers[k.toLowerCase()];
      if (!v) return null;
      return Array.isArray(v) ? (v[0] ?? null) : v;
    };
    const sig = get("x-connectpay-signature");
    const timestamp = get("x-connectpay-timestamp");
    if (!sig || !timestamp) return null;

    const payload = `${timestamp}.${rawBody.toString("utf8")}`;
    const expected = createHmac("sha256", this.hmacSecret).update(payload).digest("hex");
    if (!safeEqualHex(expected, sig)) return null;

    let parsed: ConnectPayWebhookEvent;
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as ConnectPayWebhookEvent;
    } catch {
      return null;
    }
    return this.normalize(parsed);
  }

  // ----- internals -----

  private async signedFetch<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const bodyText = body !== undefined ? JSON.stringify(body) : "";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-ConnectPay-Key": this.apiKey,
      "X-ConnectPay-Merchant": this.merchantId,
      "X-ConnectPay-Timestamp": timestamp,
    };
    if (bodyText) headers["Content-Type"] = "application/json";
    if (this.hmacSecret) {
      const payload = `${timestamp}.${method}.${path}.${bodyText}`;
      headers["X-ConnectPay-Signature"] = createHmac("sha256", this.hmacSecret)
        .update(payload)
        .digest("hex");
    }
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers,
      body: bodyText || undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ConnectPay ${method} ${path} failed: ${res.status} ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private normalize(event: ConnectPayWebhookEvent): NormalizedWebhookEvent {
    const id = event.id ?? "";
    switch (event.type) {
      case "checkout.completed": {
        const data = (event.data ?? {}) as ConnectPayCheckoutCompleted;
        return {
          id,
          type: "checkout.completed",
          data: {
            orgId: data.metadata?.orgId ?? data.external_customer_id ?? null,
            customerId: data.customer_id ?? null,
            subscriptionId: data.subscription_id ?? null,
            planId: data.metadata?.planId ?? null,
          },
        };
      }
      case "subscription.created":
      case "subscription.updated":
      case "subscription.activated": {
        const sub = (event.data ?? {}) as ConnectPaySubscriptionResource;
        return {
          id,
          type: "subscription.upserted",
          data: {
            orgId: sub.metadata?.orgId ?? sub.external_customer_id ?? null,
            customerId: sub.customer_id ?? null,
            subscriptionId: sub.id ?? null,
            planId: sub.plan_code ? this.planForPriceId(sub.plan_code) : null,
            status: mapConnectPayStatus(sub.status),
            currentPeriodStart: sub.current_period_start ?? null,
            currentPeriodEnd: sub.current_period_end ?? null,
            cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          },
        };
      }
      case "subscription.canceled":
      case "subscription.expired": {
        const sub = (event.data ?? {}) as ConnectPaySubscriptionResource;
        return {
          id,
          type: "subscription.deleted",
          data: {
            orgId: sub.metadata?.orgId ?? sub.external_customer_id ?? null,
            customerId: sub.customer_id ?? null,
          },
        };
      }
      case "invoice.paid":
      case "invoice.failed":
      case "invoice.voided":
      case "invoice.refunded": {
        const inv = (event.data ?? {}) as ConnectPayInvoiceResource;
        const status: "paid" | "failed" | "void" =
          event.type === "invoice.failed"
            ? "failed"
            : event.type === "invoice.voided"
              ? "void"
              : "paid";
        return {
          id,
          type: "invoice.upserted",
          data: {
            orgId: inv.metadata?.orgId ?? inv.external_customer_id ?? null,
            customerId: inv.customer_id ?? null,
            invoiceId: inv.id ?? null,
            amountCents: inv.amount_cents ?? 0,
            currency: (inv.currency ?? "USD").toUpperCase(),
            status,
            description: inv.description ?? null,
            hostedInvoiceUrl: inv.hosted_url ?? null,
            invoicePdfUrl: inv.pdf_url ?? null,
            paidAt: inv.paid_at ?? null,
          },
        };
      }
      default:
        return { id, type: "ignored", data: {} };
    }
  }
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function mapConnectPayStatus(
  s: string | undefined,
): "active" | "trialing" | "past_due" | "canceled" {
  switch (s) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "expired":
      return "canceled";
    default:
      return "active";
  }
}

// ----- ConnectPay webhook payload shapes (minimal). -----

interface ConnectPayMetadata {
  orgId?: string;
  planId?: string;
}

interface ConnectPayCheckoutCompleted {
  customer_id?: string;
  external_customer_id?: string;
  subscription_id?: string;
  metadata?: ConnectPayMetadata;
}

interface ConnectPaySubscriptionResource {
  id?: string;
  customer_id?: string;
  external_customer_id?: string;
  plan_code?: string;
  status?: string;
  current_period_start?: string;
  current_period_end?: string;
  cancel_at_period_end?: boolean;
  metadata?: ConnectPayMetadata;
}

interface ConnectPayInvoiceResource {
  id?: string;
  customer_id?: string;
  external_customer_id?: string;
  amount_cents?: number;
  currency?: string;
  description?: string;
  hosted_url?: string;
  pdf_url?: string;
  paid_at?: string;
  metadata?: ConnectPayMetadata;
}

interface ConnectPayWebhookEvent {
  id?: string;
  type?: string;
  data?: unknown;
}
