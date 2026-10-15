import { createHash } from "node:crypto";
import { APP_NAME } from "@mobileflow/shared";
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

// PayPal's REST API works very differently from Stripe:
//   - There's no first-class "customer" object; we mint a stable opaque
//     reference (`mf_<orgId>`) and pass it as `custom_id` on subscriptions
//     so we can resolve back to an orgId from webhook events.
//   - There's no SetupIntent. To capture a card off-session we use the v3
//     Vault setup-token flow and redirect the user to PayPal's approval
//     page (the return URL is the org subscriptions page).
//   - There's no billing portal. We deep-link to the consumer auto-pay page.
//   - Webhook signature verification calls a PayPal endpoint instead of a
//     local HMAC, so verifyWebhook does a network round-trip.

export interface PayPalCredentialsBlob {
  keys?: {
    sandbox?: { clientId?: string; clientSecret?: string; webhookId?: string };
    production?: { clientId?: string; clientSecret?: string; webhookId?: string };
  };
}

export interface PayPalConfigBlob {
  plans?: {
    sandbox?: { bohio?: string; yucayeque?: string; cacique?: string };
    production?: { bohio?: string; yucayeque?: string; cacique?: string };
  };
  returnBaseUrl?: { sandbox?: string; production?: string };
}

const CREDS_SCHEMA: AdapterFieldSchema = {
  fields: [
    {
      key: "clientId",
      label: "Client ID",
      type: "string",
      placeholder: "AYi…",
      mode: "per-mode",
      required: true,
    },
    {
      key: "clientSecret",
      label: "Client secret",
      type: "secret",
      placeholder: "EL…",
      mode: "per-mode",
      required: true,
    },
    {
      key: "webhookId",
      label: "Webhook ID",
      type: "string",
      placeholder: "4UY…",
      helpText:
        "Dashboard → My Apps & Credentials → your app → Webhooks → the webhook's ID. Used to verify signatures.",
      mode: "per-mode",
    },
  ],
};

const CONFIG_SCHEMA: AdapterFieldSchema = {
  fields: [
    {
      key: "plans.bohio",
      label: "Plan ID — Bohío",
      type: "string",
      placeholder: "P-…",
      mode: "per-mode",
    },
    {
      key: "plans.yucayeque",
      label: "Plan ID — Yucayeque",
      type: "string",
      placeholder: "P-…",
      mode: "per-mode",
    },
    {
      key: "plans.cacique",
      label: "Plan ID — Cacique",
      type: "string",
      placeholder: "P-…",
      mode: "per-mode",
    },
  ],
};

const SANDBOX_API = "https://api-m.sandbox.paypal.com";
const LIVE_API = "https://api-m.paypal.com";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class PayPalAdapter implements PaymentAdapter {
  readonly id = "paypal" as const;
  readonly displayName = "PayPal";
  readonly mode: ProcessorMode;

  private readonly apiBase: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly webhookId: string | null;
  private readonly plans: { bohio?: string; yucayeque?: string; cacique?: string };
  private token: CachedToken | null = null;

  constructor(mode: ProcessorMode, creds: PayPalCredentialsBlob, config: PayPalConfigBlob) {
    this.mode = mode;
    const modeCreds = creds.keys?.[mode] ?? {};
    if (!modeCreds.clientId || !modeCreds.clientSecret) {
      throw new Error(`PayPal: client id and secret are required for ${mode} mode`);
    }
    this.clientId = modeCreds.clientId;
    this.clientSecret = modeCreds.clientSecret;
    this.webhookId = modeCreds.webhookId ?? null;
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
      provider: "paypal",
      mode: this.mode,
      // The web side only needs the client id (to optionally render PayPal
      // smart buttons in-line later). The server keeps the secret.
      publicConfig: { clientId: this.clientId },
    };
  }

  // PayPal doesn't have customer objects. We mint a deterministic ref that
  // travels on subscription metadata so the webhook can resolve back to us.
  async createCustomer(input: CreateCustomerInput): Promise<string> {
    return `mf_${input.orgId}`;
  }

  async updateCustomer(_customerId: string, _patch: UpdateCustomerInput): Promise<void> {
    // No-op. PayPal stores the payer's profile on their side; we can't push
    // an address into it. We still keep `billingInfo` locally for invoices.
  }

  // Hosted off-session capture via v3 Vault setup-tokens. Returns the
  // approval URL — the frontend just redirects to it. After approval PayPal
  // bounces back to `return_url` and appends `approval_token_id` (the
  // setup-token id) and `approval_session_id` as query parameters. The
  // bounce-back route `/billing/paypal-vault/return` exchanges that
  // setup-token id for a payment-token via `attachPaymentMethod`.
  //
  // Vault is a per-app feature on PayPal that isn't enabled by default;
  // many sandbox accounts can't enable it at all. When PayPal returns
  // NOT_AUTHORIZED we degrade to the consumer auto-pay page — the canonical
  // PayPal UX for "change saved payment method" anyway.
  async createSetupIntent(
    customerId: string,
    urls?: { successUrl: string; cancelUrl: string },
  ): Promise<SetupIntentResult> {
    if (!urls) throw new Error("PayPal vault flow requires success/cancel URLs");
    try {
      const res = await this.fetchJson<{
        id: string;
        links?: Array<{ rel: string; href: string }>;
      }>("POST", "/v3/vault/setup-tokens", {
        payment_source: {
          paypal: {
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            experience_context: {
              return_url: urls.successUrl,
              cancel_url: urls.cancelUrl,
            },
          },
        },
      });
      const approve = res.links?.find((l) => l.rel === "approve")?.href;
      if (!approve) throw new Error("PayPal returned a setup token with no approve link");
      return { redirectUrl: approve };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 403 NOT_AUTHORIZED = the PayPal app doesn't have the Vault feature
      // enabled. Send the user to the consumer auto-pay page instead, where
      // they can manage payment methods directly with PayPal.
      if (msg.includes("NOT_AUTHORIZED") || msg.includes(" 403 ")) {
        const portal = await this.createBillingPortal(customerId, urls.successUrl);
        return { redirectUrl: portal.url };
      }
      throw err;
    }
  }

  // After approval, the client should call our API which calls this. For
  // now `paymentMethodId` is treated as the v3 setup-token id; we exchange
  // it for a payment-token (vault).
  //
  // `customer.id` on `/v3/vault/payment-tokens` must be a PayPal-generated
  // customer ID (~13 chars). Free-tier orgs only have the synthetic
  // `mf_<uuid>` placeholder from `createCustomer`, which PayPal rejects as
  // INVALID_STRING_LENGTH. For those we omit the `customer` field — PayPal
  // attaches against the buyer who approved the setup-token — and capture
  // the real customer.id PayPal returns so we can persist it.
  async attachPaymentMethod(
    customerId: string,
    paymentMethodId: string,
  ): Promise<{ customerId: string | null; vaultTokenId: string | null }> {
    const isSynthetic = customerId.startsWith("mf_");
    const body: Record<string, unknown> = {
      payment_source: { token: { id: paymentMethodId, type: "SETUP_TOKEN" } },
    };
    if (!isSynthetic) body.customer = { id: customerId };
    const res = await this.fetchJson<{ id: string; customer?: { id?: string } }>(
      "POST",
      "/v3/vault/payment-tokens",
      body,
    );
    const returnedCustomerId = res.customer?.id ?? null;
    return {
      customerId: isSynthetic ? returnedCustomerId : null,
      vaultTokenId: res.id ?? null,
    };
  }

  // PayPal stashes the chosen payment instrument on the subscription itself
  // (`subscriber.payment_source.card` for cards; for PayPal-balance / bank
  // payers there's no `.card` and we surface a generic `paypal` type that
  // the UI renders as "PayPal account"). When the org hasn't subscribed yet
  // but did vault a payment method, fall back to reading the vault token
  // directly so free-tier orgs can still see their saved payment method.
  async getDefaultPaymentMethod(
    _customerId: string,
    opts?: { subscriptionId?: string | null; vaultTokenId?: string | null },
  ): Promise<PaymentMethodSummary | null> {
    const subId = opts?.subscriptionId;
    if (subId) {
      let sub: PayPalSubscriptionResource;
      try {
        sub = await this.fetchJson<PayPalSubscriptionResource>(
          "GET",
          `/v1/billing/subscriptions/${encodeURIComponent(subId)}`,
        );
      } catch {
        return null;
      }
      const card = sub.subscriber?.payment_source?.card;
      if (card) {
        const expiry = card.expiry ?? "";
        const [yearStr, monthStr] = expiry.split("-");
        return {
          type: "card",
          brand: (card.brand ?? "card").toLowerCase(),
          last4: card.last_digits ?? "????",
          expMonth: Number(monthStr) || 0,
          expYear: Number(yearStr) || 0,
        };
      }
      // No card on file — buyer paid via PayPal balance, bank, etc.
      return { type: "paypal" };
    }
    const tokenId = opts?.vaultTokenId;
    if (!tokenId) return null;
    let tok: {
      payment_source?: {
        card?: { brand?: string; last_digits?: string; expiry?: string };
        paypal?: unknown;
      };
    };
    try {
      tok = await this.fetchJson(
        "GET",
        `/v3/vault/payment-tokens/${encodeURIComponent(tokenId)}`,
      );
    } catch {
      return null;
    }
    const card = tok.payment_source?.card;
    if (card) {
      const expiry = card.expiry ?? "";
      const [yearStr, monthStr] = expiry.split("-");
      return {
        type: "card",
        brand: (card.brand ?? "card").toLowerCase(),
        last4: card.last_digits ?? "????",
        expMonth: Number(monthStr) || 0,
        expYear: Number(yearStr) || 0,
      };
    }
    if (tok.payment_source?.paypal) return { type: "paypal" };
    return null;
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string }> {
    const planId = this.priceIdForPlan(input.planId);
    if (!planId) {
      throw new Error(`PayPal: no plan configured for ${input.planId} in ${this.mode} mode`);
    }
    const res = await this.fetchJson<{
      id: string;
      links?: Array<{ rel: string; href: string }>;
    }>("POST", "/v1/billing/subscriptions", {
      plan_id: planId,
      custom_id: input.orgId,
      application_context: {
        brand_name: APP_NAME,
        user_action: "SUBSCRIBE_NOW",
        return_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
    });
    const approve = res.links?.find((l) => l.rel === "approve")?.href;
    if (!approve) throw new Error("PayPal returned a subscription with no approve link");
    return { url: approve };
  }

  // PayPal has no merchant-driven portal API. Deep-link to the payer's
  // auto-pay page; they manage cancellation/payment-method updates there.
  async createBillingPortal(_customerId: string, _returnUrl: string): Promise<{ url: string }> {
    const base =
      this.mode === "sandbox"
        ? "https://www.sandbox.paypal.com/myaccount/autopay/"
        : "https://www.paypal.com/myaccount/autopay/";
    return { url: base };
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

  // Provisioning helper used by the admin UI to bootstrap a Product + Plan
  // in PayPal's catalog without an admin having to run curl by hand. One
  // call returns both ids; the UI only stores the plan id (the product id
  // is recoverable from the plan if ever needed via `GET /v1/billing/plans`).
  async createProductAndPlan(input: {
    productName: string;
    planName: string;
    priceCents: number;
    currency: string;
  }): Promise<{ productId: string; planId: string }> {
    const product = await this.fetchJson<{ id: string }>(
      "POST",
      "/v1/catalogs/products",
      {
        name: input.productName,
        type: "SERVICE",
        category: "SOFTWARE",
      },
    );
    if (!product.id) throw new Error("PayPal returned a product with no id");
    const plan = await this.fetchJson<{ id: string }>(
      "POST",
      "/v1/billing/plans",
      {
        product_id: product.id,
        name: input.planName,
        billing_cycles: [
          {
            frequency: { interval_unit: "MONTH", interval_count: 1 },
            tenure_type: "REGULAR",
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: {
              fixed_price: {
                value: (input.priceCents / 100).toFixed(2),
                currency_code: input.currency,
              },
            },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true },
      },
    );
    if (!plan.id) throw new Error("PayPal returned a plan with no id");
    return { productId: product.id, planId: plan.id };
  }

  async verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedWebhookEvent | null> {
    if (!this.webhookId) return null;
    const get = (k: string): string | null => {
      const v = headers[k] ?? headers[k.toLowerCase()];
      if (!v) return null;
      return Array.isArray(v) ? (v[0] ?? null) : v;
    };
    const authAlgo = get("paypal-auth-algo");
    const certUrl = get("paypal-cert-url");
    const transmissionId = get("paypal-transmission-id");
    const transmissionSig = get("paypal-transmission-sig");
    const transmissionTime = get("paypal-transmission-time");
    if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
      return null;
    }

    let parsed: PayPalWebhookEvent;
    try {
      parsed = JSON.parse(rawBody.toString("utf8")) as PayPalWebhookEvent;
    } catch {
      return null;
    }

    const verify = await this.fetchJson<{ verification_status: string }>(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: this.webhookId,
        webhook_event: parsed,
      },
    );
    if (verify.verification_status !== "SUCCESS") return null;
    return this.normalize(parsed);
  }

  // ----- internals -----

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now + 30_000) return this.token.accessToken;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await fetch(`${this.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new Error(`PayPal token request failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      accessToken: body.access_token,
      expiresAt: now + body.expires_in * 1000,
    };
    return body.access_token;
  }

  private async fetchJson<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getAccessToken();
    // PayPal-Request-Id is recommended for idempotency on POSTs that create
    // billable objects. We derive a deterministic value from the body so a
    // network retry doesn't double-charge.
    const requestId = body
      ? createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32)
      : undefined;
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PayPal ${method} ${path} failed: ${res.status} ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private normalize(event: PayPalWebhookEvent): NormalizedWebhookEvent {
    const id = event.id ?? "";
    switch (event.event_type) {
      case "BILLING.SUBSCRIPTION.CREATED":
      case "BILLING.SUBSCRIPTION.ACTIVATED":
      case "BILLING.SUBSCRIPTION.UPDATED":
      case "BILLING.SUBSCRIPTION.RE-ACTIVATED": {
        const sub = (event.resource ?? {}) as PayPalSubscriptionResource;
        const planId = sub.plan_id ? this.planForPriceId(sub.plan_id) : null;
        return {
          id,
          type: "subscription.upserted",
          data: {
            orgId: sub.custom_id ?? null,
            customerId: sub.subscriber?.payer_id ?? sub.custom_id ?? null,
            subscriptionId: sub.id ?? null,
            planId,
            status: mapPayPalStatus(sub.status),
            currentPeriodStart: sub.billing_info?.last_payment?.time ?? null,
            currentPeriodEnd: sub.billing_info?.next_billing_time ?? null,
            cancelAtPeriodEnd: sub.status === "CANCELLED",
          },
        };
      }
      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.EXPIRED":
      case "BILLING.SUBSCRIPTION.SUSPENDED": {
        const sub = (event.resource ?? {}) as PayPalSubscriptionResource;
        return {
          id,
          type:
            event.event_type === "BILLING.SUBSCRIPTION.SUSPENDED"
              ? "subscription.upserted"
              : "subscription.deleted",
          data: {
            orgId: sub.custom_id ?? null,
            customerId: sub.subscriber?.payer_id ?? sub.custom_id ?? null,
            subscriptionId: sub.id ?? null,
            status: mapPayPalStatus(sub.status),
          },
        };
      }
      case "PAYMENT.SALE.COMPLETED":
      case "PAYMENT.SALE.REFUNDED":
      case "PAYMENT.CAPTURE.COMPLETED":
      case "PAYMENT.CAPTURE.REFUNDED":
      case "PAYMENT.CAPTURE.DENIED": {
        const sale = (event.resource ?? {}) as PayPalSaleResource;
        const customId =
          sale.custom ??
          sale.custom_id ??
          sale.supplementary_data?.related_ids?.subscription_id ??
          null;
        // PayPal's two event families use different amount shapes:
        //   PAYMENT.SALE.*    → amount.total + amount.currency       (v1)
        //   PAYMENT.CAPTURE.* → amount.value + amount.currency_code  (v2)
        // Try both so subscription payments (which fire SALE.COMPLETED)
        // don't end up with amount_cents = 0.
        const amount = sale.amount ?? sale.gross_amount;
        const amountStr = amount?.value ?? amount?.total ?? null;
        const amountCents = amountStr ? Math.round(parseFloat(amountStr) * 100) : 0;
        const currency = amount?.currency_code ?? amount?.currency ?? "USD";
        const failed =
          event.event_type === "PAYMENT.CAPTURE.DENIED" ||
          event.event_type === "PAYMENT.SALE.REFUNDED" ||
          event.event_type === "PAYMENT.CAPTURE.REFUNDED";
        // PayPal doesn't expose a per-transaction consumer-facing URL — the
        // sale id we get on PAYMENT.SALE.COMPLETED isn't the same id PayPal
        // uses on its /myaccount/activities/details/... pages. Leave both
        // URL fields null; the UI renders the date as plain text in that case.
        return {
          id,
          type: "invoice.upserted",
          data: {
            orgId: customId,
            customerId: sale.payer?.payer_id ?? null,
            invoiceId: sale.id ?? null,
            amountCents,
            currency,
            status: failed ? "failed" : "paid",
            description: sale.description ?? null,
            hostedInvoiceUrl: null,
            invoicePdfUrl: null,
            paidAt: sale.create_time ?? null,
          },
        };
      }
      default:
        return { id, type: "ignored", data: {} };
    }
  }
}

function orgIdFromCustomer(customerId: string): string {
  return customerId.startsWith("mf_") ? customerId.slice(3) : customerId;
}

function mapPayPalStatus(
  s: string | undefined,
): "active" | "trialing" | "past_due" | "canceled" {
  switch (s) {
    case "ACTIVE":
      return "active";
    case "APPROVAL_PENDING":
    case "APPROVED":
      return "trialing";
    case "SUSPENDED":
      return "past_due";
    case "CANCELLED":
    case "EXPIRED":
      return "canceled";
    default:
      return "active";
  }
}

// ----- PayPal webhook payload shapes (minimal — we only read what we use). -----

interface PayPalAmount {
  // v2 shape (CAPTURE events)
  value?: string;
  currency_code?: string;
  // v1 shape (SALE events — what subscription payments fire)
  total?: string;
  currency?: string;
}

interface PayPalSubscriptionResource {
  id?: string;
  plan_id?: string;
  status?: string;
  custom_id?: string;
  subscriber?: {
    payer_id?: string;
    email_address?: string;
    payment_source?: {
      card?: {
        name?: string;
        last_digits?: string;
        brand?: string;
        // `expiry` is YYYY-MM, e.g. "2030-01"
        expiry?: string;
      };
    };
  };
  billing_info?: {
    next_billing_time?: string;
    last_payment?: { time?: string; amount?: PayPalAmount };
  };
}

interface PayPalSaleResource {
  id?: string;
  custom?: string;
  custom_id?: string;
  description?: string;
  create_time?: string;
  amount?: PayPalAmount;
  gross_amount?: PayPalAmount;
  payer?: { payer_id?: string };
  supplementary_data?: { related_ids?: { subscription_id?: string } };
}

interface PayPalWebhookEvent {
  id?: string;
  event_type?: string;
  resource?: unknown;
}
