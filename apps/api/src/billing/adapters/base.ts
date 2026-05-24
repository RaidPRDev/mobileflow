// Adapter interface for payment processors (Stripe today, ConnectPay etc later).
//
// Every adapter:
//   1. Declares its credential and config field shape (drives the admin UI).
//   2. Implements a normalized lifecycle: create/lookup customer, set up an
//      off-session card, attach the default payment method, list its summary,
//      open a hosted checkout/portal, and verify+normalize webhooks.
//
// The admin UI does NOT know about Stripe specifically — it reads the field
// schemas from the registry and renders them. To add ConnectPay later, drop
// a new adapter into adapters/connectpay.ts and register it; no UI changes.

export type ProcessorMode = "sandbox" | "production";

export type AdapterFieldType = "string" | "secret" | "url";

// One key in the admin form. `mode: "per-mode"` means the field has separate
// sandbox vs production values stored under that key (e.g. publishableKey).
// `mode: "shared"` means a single value across both modes (rare — most things
// differ per mode).
export interface AdapterField {
  key: string;
  label: string;
  type: AdapterFieldType;
  placeholder?: string;
  helpText?: string;
  mode: "per-mode" | "shared";
  required?: boolean;
}

export interface AdapterFieldSchema {
  fields: AdapterField[];
}

// Sanitized view returned to the admin UI. Secrets are replaced with a boolean
// `set` flag so we never ship the cleartext over the wire — the form shows
// "Configured" and lets admins overwrite.
export type SanitizedCredentials = Record<
  string,
  string | boolean | { sandbox?: string | boolean; production?: string | boolean }
>;

export type SanitizedConfig = Record<
  string,
  string | null | { sandbox?: string | null; production?: string | null }
>;

export interface PaymentMethodCardSummary {
  type: "card";
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface PaymentMethodOtherSummary {
  type: string; // anything non-card
}

export type PaymentMethodSummary = PaymentMethodCardSummary | PaymentMethodOtherSummary;

export interface CreateCustomerInput {
  orgId: string;
  name?: string | null;
  email?: string | null;
}

export interface UpdateCustomerInput {
  name?: string | null;
  email?: string | null;
  address?: {
    country?: string | null;
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
  };
}

export interface CheckoutInput {
  orgId: string;
  planId: "bohio" | "yucayeque" | "cacique";
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface NormalizedWebhookEvent {
  type:
    | "checkout.completed"
    | "subscription.upserted"
    | "subscription.deleted"
    | "invoice.upserted"
    | "ignored";
  // Original event id for idempotency / logging.
  id: string;
  // Free-form payload — billing.ts handler maps to DB writes.
  data: Record<string, unknown>;
}

// What we ship over the wire to the web app on `/api/billing/config` so the
// payment form knows which processor to render and which publishable key (if
// any) to load. Anything else processor-specific lives in `publicConfig`.
export interface PublicBillingConfig {
  provider: string;
  mode: ProcessorMode;
  publicConfig: Record<string, string | null>;
}

// Result of `createSetupIntent`. Stripe uses an inline split-card form that
// confirms a SetupIntent against its `clientSecret`; PayPal/ConnectPay don't
// have an equivalent and instead hand off to a hosted vault page that the
// browser must redirect to. Adapters return exactly one of the two so the
// frontend can branch on which is present.
export interface SetupIntentResult {
  clientSecret?: string;
  redirectUrl?: string;
}

export type ProviderIdLiteral = "stripe" | "paypal" | "connectpay";

export interface PaymentAdapter {
  readonly id: ProviderIdLiteral;
  readonly displayName: string;
  readonly mode: ProcessorMode;

  // Schema (static, doesn't need an instance — but easier on the registry to
  // make them instance fields since the active adapter is already loaded).
  credentialsSchema(): AdapterFieldSchema;
  configSchema(): AdapterFieldSchema;

  // What the web app needs publicly (no secrets).
  publicBillingConfig(): PublicBillingConfig;

  // Customer lifecycle.
  createCustomer(input: CreateCustomerInput): Promise<string>;
  updateCustomer(customerId: string, patch: UpdateCustomerInput): Promise<void>;

  // Payment method setup (off-session). Adapters that have a true SetupIntent
  // analogue (Stripe) return `{ clientSecret }`; those that capture cards via
  // a hosted page (PayPal, ConnectPay) return `{ redirectUrl }` and use the
  // `urls` argument as the bounce-back targets after approval/cancel.
  createSetupIntent(
    customerId: string,
    urls?: { successUrl: string; cancelUrl: string },
  ): Promise<SetupIntentResult>;
  attachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  // `opts.subscriptionId` lets adapters that don't expose a per-customer
  // default-payment-method endpoint (PayPal) read the saved card off the
  // subscription instead. Stripe ignores it and uses its customer-level
  // invoice_settings.default_payment_method.
  getDefaultPaymentMethod(
    customerId: string,
    opts?: { subscriptionId?: string | null },
  ): Promise<PaymentMethodSummary | null>;

  // Hosted flows.
  createCheckoutSession(input: CheckoutInput): Promise<{ url: string }>;
  createBillingPortal(customerId: string, returnUrl: string): Promise<{ url: string }>;

  // Plan ↔ price mapping (config-driven).
  priceIdForPlan(planId: string): string | null;
  planForPriceId(priceId: string): string | null;

  // Webhook verification + normalization. Returns null if the signature fails.
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<NormalizedWebhookEvent | null>;
}
