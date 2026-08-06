import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, CreditCard, ExternalLink, Info } from "lucide-react";
import stripeIcon from "@assets/icons/stripe-icon.svg";
import paypalIcon from "@assets/icons/paypal-icon.svg";
import connectpayIcon from "@assets/icons/connectpay-icon.svg";
import {
  Badge,
  Button,
  Input,
  Label,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  cn,
  Loading,
} from "@mobileflow/ui";
import { ApiError, api, type AdapterField, type PaymentProcessorRow } from "../api/client";

type Mode = "sandbox" | "production";

const PROCESSOR_ICONS: Record<string, string> = {
  stripe: stripeIcon,
  paypal: paypalIcon,
  connectpay: connectpayIcon,
};

export function AdminPaymentProcessorsPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "payment-processors"],
    queryFn: () => api.admin.paymentProcessors(),
  });

  const update = useMutation({
    mutationFn: (args: { provider: string; body: Parameters<typeof api.admin.updatePaymentProcessor>[1] }) =>
      api.admin.updatePaymentProcessor(args.provider, args.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "payment-processors"] }),
  });
  const remove = useMutation({
    mutationFn: (provider: string) => api.admin.deletePaymentProcessor(provider),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "payment-processors"] }),
  });

  const activeProvider = q.data?.processors.find((p) => p.enabled)?.provider ?? null;
  const apiBaseUrl = q.data?.apiBaseUrl ?? "";

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Payment Processors</h1>
      </div>
      <p className="text-help">
        Only one processor can be active at a time. Switching the active processor changes which
        gateway handles checkout, subscriptions, and webhooks. Existing customer/subscription ids
        are kept per-processor — old data is preserved if you switch back.
      </p>

      <div className="page-section stack-sm">
        {q.isLoading && (
          <p className="text-help">
            <Loading />
          </p>
        )}
        {q.data?.processors.map((row) => (
          <ProcessorCard
            key={row.provider}
            row={row}
            isActive={activeProvider === row.provider}
            apiBaseUrl={apiBaseUrl}
            onSave={(body) => update.mutate({ provider: row.provider, body })}
            onDelete={() => remove.mutate(row.provider)}
            saving={update.isPending}
          />
        ))}
      </div>
    </div>
  );
}

function ProcessorCard({
  row,
  isActive,
  apiBaseUrl,
  onSave,
  onDelete,
  saving,
}: {
  row: PaymentProcessorRow;
  isActive: boolean;
  apiBaseUrl: string;
  onSave: (body: Parameters<typeof api.admin.updatePaymentProcessor>[1]) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(row.mode);
  // Form state. `secret` fields hold the new-cleartext-to-send for each mode;
  // empty string = "don't touch". `string` fields hold the visible value
  // we'll send (empty string = clear it, since price IDs need to be clearable).
  const [creds, setCreds] = useState<Record<string, Record<Mode, string>>>(() =>
    initCreds(row),
  );
  const [config, setConfig] = useState<Record<string, Record<Mode, string>>>(() =>
    initConfig(row),
  );
  const [error, setError] = useState<string | null>(null);

  // When the server data changes (after a save), refresh local form state.
  useEffect(() => {
    setCreds(initCreds(row));
    setConfig(initConfig(row));
    setMode(row.mode);
  }, [row]);

  const credFields = row.credentialsSchema.fields;
  const configFields = row.configSchema.fields;

  const submit = (extra?: { enabled?: boolean }) => {
    setError(null);
    try {
      const credsBody = serializeCredentials(credFields, creds);
      const configBody = serializeConfig(configFields, config);
      onSave({
        enabled: extra?.enabled,
        mode,
        credentials: credsBody,
        config: configBody,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  };

  return (
    <div className={cn("accordion-item", open && "is-open")}>
      <div className="accordion-header">
        <button
          type="button"
          className={cn("accordion-trigger", open && "is-open")}
          onClick={() => setOpen((s) => !s)}
          aria-expanded={open}
        >
          <span className="accordion-trigger-content">
            <span style={{ fontWeight: 500 }}>{row.displayName}</span>
          </span>
          {/* Status badge rides with the chevron on the right so the left edge
              of every row is just the processor name. */}
          <span className="accordion-trigger-meta">
            {isActive ? (
              <Badge variant="success">Active · {row.mode}</Badge>
            ) : row.updatedAt ? (
              <Badge variant="outline">Configured · inactive</Badge>
            ) : (
              <Badge variant="outline">Not configured</Badge>
            )}
            <ChevronDown size={16} className="accordion-chevron" />
          </span>
        </button>
      </div>
      {/* Always mounted so the panel's height can animate; the collapse wrapper
          hides it from view and from the tab order while closed. */}
      <div className="accordion-collapse">
        <div className="accordion-collapse__inner">
          <div className="accordion-panel is-padded-top stack-sm">
            <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)} className="stack-sm">
              <div className="row" style={{ alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <TabsList>
                  <TabsTrigger value="sandbox">Sandbox</TabsTrigger>
                  <TabsTrigger value="production">Production</TabsTrigger>
                </TabsList>
                {(() => {
                  const links = externalLinks(row.provider, mode);
                  return links ? (
                    <ExternalAnchor href={links.dashboard}>Open dashboard</ExternalAnchor>
                  ) : null;
                })()}
                <Label
                  className="is-small"
                  htmlFor={`active-${row.provider}`}
                  style={{ marginLeft: "auto" }}
                >
                  Set as active
                </Label>
                <Switch
                  id={`active-${row.provider}`}
                  checked={isActive}
                  onCheckedChange={(v) => submit({ enabled: v })}
                  disabled={saving}
                />
              </div>
              {(() => {
                const links = externalLinks(row.provider, mode);
                return (
                  <p className="text-help processor-webhook">
                    <Info size={12} aria-hidden /> Webhook endpoint:{" "}
                    <code>{`${apiBaseUrl}/api/billing/webhook/${row.provider}`}</code>
                    {links && (
                      <ExternalAnchor href={links.webhooks}>
                        Configure in {row.displayName}
                      </ExternalAnchor>
                    )}
                  </p>
                );
              })()}
              {(["sandbox", "production"] as const).map((m) => {
                const links = externalLinks(row.provider, m);
                return (
                <TabsContent key={m} value={m} className="tabs-content--padded stack-sm">
                  <fieldset className="billing-address-group">
                    <legend className="billing-address-group__legend">
                      Credentials
                      {links && (
                        <ExternalAnchor href={links.apiKeys}>API keys</ExternalAnchor>
                      )}
                    </legend>
                    {/* Fields are capped at 560px, so the brand mark fills the
                        space beside them instead of leaving the row empty. */}
                    <div className="processor-creds">
                      <div className="processor-creds__fields">
                        {credFields.map((field) => (
                          <CredentialInput
                            key={field.key}
                            field={field}
                            mode={m}
                            value={creds[field.key]?.[m] ?? ""}
                            isSet={isSecretSet(row, field.key, m)}
                            onChange={(v) =>
                              setCreds((s) => ({
                                ...s,
                                [field.key]: {
                                  ...(s[field.key] ?? { sandbox: "", production: "" }),
                                  [m]: v,
                                },
                              }))
                            }
                          />
                        ))}
                      </div>
                      <ProcessorBrand provider={row.provider} displayName={row.displayName} />
                    </div>
                    {row.provider === "stripe" && m === "sandbox" && (
                      <StripeListenHint provider={row.provider} />
                    )}
                  </fieldset>

                  <fieldset className="billing-address-group">
                    <legend className="billing-address-group__legend">
                      Plan price IDs
                      {links && (
                        <ExternalAnchor href={links.products}>Product catalog</ExternalAnchor>
                      )}
                    </legend>
                    {configFields.map((field) => (
                      <div key={field.key} className="settings-field">
                        <Label className="is-small">{field.label}</Label>
                        <div className="row" style={{ gap: 8, alignItems: "stretch" }}>
                          <div style={{ flex: 1 }}>
                            <Input
                              value={config[field.key]?.[m] ?? ""}
                              placeholder={field.placeholder}
                              onChange={(e) =>
                                setConfig((s) => ({
                                  ...s,
                                  [field.key]: {
                                    ...(s[field.key] ?? { sandbox: "", production: "" }),
                                    [m]: e.target.value,
                                  },
                                }))
                              }
                            />
                          </div>
                          {row.provider === "paypal" && (
                            <PayPalCreatePlanButton
                              fieldKey={field.key}
                              mode={m}
                              onCreated={(planId) =>
                                setConfig((s) => ({
                                  ...s,
                                  [field.key]: {
                                    ...(s[field.key] ?? { sandbox: "", production: "" }),
                                    [m]: planId,
                                  },
                                }))
                              }
                              onError={(msg) => setError(msg)}
                            />
                          )}
                        </div>
                        {field.helpText && <p className="text-help">{field.helpText}</p>}
                      </div>
                    ))}
                  </fieldset>
                </TabsContent>
                );
              })}
            </Tabs>

            {error && <p className="text-error">{error}</p>}

            <div className="row-end">
              {row.updatedAt && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (confirm("Remove this processor's credentials? Existing customers stay in the DB but billing will fail until reconfigured.")) {
                      onDelete();
                    }
                  }}
                >
                  Remove
                </Button>
              )}
              <Button onClick={() => submit()} disabled={saving}>
                Save
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// The processor's wordmark, on its own light tile. Several of the brand SVGs
// are dark navy or near-black, which disappears against the dark card — the
// tile gives them a consistent light surface to sit on in either theme.
function ProcessorBrand({ provider, displayName }: { provider: string; displayName: string }) {
  const icon = PROCESSOR_ICONS[provider];
  return (
    <div className="processor-brand">
      {icon ? (
        <img src={icon} alt={displayName} className="processor-brand__logo" />
      ) : (
        <span className="processor-brand__fallback">
          <CreditCard size={28} aria-hidden />
          <span>{displayName}</span>
        </span>
      )}
    </div>
  );
}

function CredentialInput({
  field,
  mode,
  value,
  isSet,
  onChange,
}: {
  field: AdapterField;
  mode: Mode;
  value: string;
  isSet: boolean;
  onChange: (v: string) => void;
}) {
  const isSecret = field.type === "secret";
  return (
    <div className="settings-field">
      <Label className="is-small">
        {field.label}
        {isSecret && isSet && (
          <Badge variant="success" style={{ marginLeft: 8 }}>
            Configured
          </Badge>
        )}
      </Label>
      <Input
        type={isSecret ? "password" : "text"}
        value={value}
        placeholder={isSet && isSecret ? "Leave blank to keep current" : field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      {field.helpText && <p className="text-help">{field.helpText}</p>}
      {mode === "sandbox" && field.required && !isSet && !value && (
        <p className="text-help">Required for sandbox mode</p>
      )}
    </div>
  );
}

// ----- helpers -----

function initCreds(row: PaymentProcessorRow): Record<string, Record<Mode, string>> {
  const out: Record<string, Record<Mode, string>> = {};
  for (const field of row.credentialsSchema.fields) {
    const stored = row.credentials[field.key];
    const safe = (v: string | boolean | undefined): string =>
      typeof v === "string" ? v : "";
    if (stored && typeof stored === "object") {
      out[field.key] = {
        sandbox: safe(stored.sandbox),
        production: safe(stored.production),
      };
    } else {
      out[field.key] = { sandbox: "", production: "" };
    }
  }
  return out;
}

function initConfig(row: PaymentProcessorRow): Record<string, Record<Mode, string>> {
  const out: Record<string, Record<Mode, string>> = {};
  for (const field of row.configSchema.fields) {
    const stored = row.config[field.key];
    if (stored && typeof stored === "object") {
      out[field.key] = {
        sandbox: stored.sandbox ?? "",
        production: stored.production ?? "",
      };
    } else {
      out[field.key] = { sandbox: "", production: "" };
    }
  }
  return out;
}

function isSecretSet(row: PaymentProcessorRow, key: string, mode: Mode): boolean {
  const stored = row.credentials[key];
  if (stored && typeof stored === "object") {
    const v = stored[mode];
    return v === true;
  }
  return false;
}

// Build the credentials payload. Empty strings on secrets are dropped (the
// server's deepMerge with `dropEmpty: true` would also drop them, but we keep
// the wire payload small).
function serializeCredentials(
  fields: AdapterField[],
  state: Record<string, Record<Mode, string>>,
): Record<string, unknown> {
  // Stripe's blob shape: { keys: { sandbox: { publishableKey, ... }, production: { ... } } }
  const out: { keys: { sandbox: Record<string, string>; production: Record<string, string> } } = {
    keys: { sandbox: {}, production: {} },
  };
  for (const field of fields) {
    if (field.mode !== "per-mode") continue;
    const values = state[field.key] ?? { sandbox: "", production: "" };
    if (values.sandbox) out.keys.sandbox[field.key] = values.sandbox;
    if (values.production) out.keys.production[field.key] = values.production;
  }
  return out;
}

// Config (price IDs). Empty string DOES overwrite — clearing a price is a
// real action.
function serializeConfig(
  fields: AdapterField[],
  state: Record<string, Record<Mode, string>>,
): Record<string, unknown> {
  // Stripe shape: { prices: { sandbox: { bohio, yucayeque, cacique }, production: { ... } } }
  const out: Record<string, Record<Mode, Record<string, string>>> = {};
  for (const field of fields) {
    if (field.mode !== "per-mode") continue;
    const [section, leaf] = field.key.split(".");
    if (!section || !leaf) continue;
    out[section] = out[section] ?? { sandbox: {}, production: {} };
    const values = state[field.key] ?? { sandbox: "", production: "" };
    out[section].sandbox[leaf] = values.sandbox;
    out[section].production[leaf] = values.production;
  }
  return out;
}

// Deep-links into the processor's own dashboard, switched by mode so admins
// land in the right environment without re-toggling test/live. Returning null
// lets the UI omit a link when the processor doesn't expose the relevant area.
function externalLinks(
  provider: string,
  mode: Mode,
): { dashboard: string; apiKeys: string; webhooks: string; products: string } | null {
  if (provider === "stripe") {
    const prefix = mode === "sandbox" ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
    return {
      dashboard: prefix,
      apiKeys: `${prefix}/apikeys`,
      webhooks: `${prefix}/webhooks`,
      products: `${prefix}/products`,
    };
  }
  if (provider === "paypal") {
    // PayPal's developer dashboard hosts app credentials and webhook config
    // for both sandbox and live; switching environments happens inside the
    // dashboard rather than via URL prefix.
    const dashboard = "https://developer.paypal.com/dashboard/applications";
    return {
      dashboard,
      apiKeys: `${dashboard}/${mode === "sandbox" ? "sandbox" : "live"}`,
      webhooks: `${dashboard}/${mode === "sandbox" ? "sandbox" : "live"}`,
      products:
        mode === "sandbox"
          ? "https://www.sandbox.paypal.com/billing/plans"
          : "https://www.paypal.com/billing/plans",
    };
  }
  if (provider === "connectpay") {
    const prefix =
      mode === "sandbox"
        ? "https://sandbox.connectpaypr.com"
        : "https://merchant.connectpaypr.com";
    return {
      dashboard: prefix,
      apiKeys: `${prefix}/settings/api`,
      webhooks: `${prefix}/settings/webhooks`,
      products: `${prefix}/plans`,
    };
  }
  return null;
}

function ExternalAnchor({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="external-link"
    >
      {children}
      <ExternalLink size={11} aria-hidden />
    </a>
  );
}

// Provisions a Product + Plan in PayPal's catalog and fills the resulting
// plan id into the Input. Only meaningful for field keys shaped like
// `plans.bohio` / `plans.yucayeque` / `plans.cacique`; renders nothing for
// any other key shape so a future PayPal config field can't accidentally
// trigger plan creation.
function PayPalCreatePlanButton({
  fieldKey,
  mode,
  onCreated,
  onError,
}: {
  fieldKey: string;
  mode: Mode;
  onCreated: (planId: string) => void;
  onError: (msg: string) => void;
}) {
  const planKey = fieldKey.startsWith("plans.") ? fieldKey.slice("plans.".length) : null;
  const isTier =
    planKey === "bohio" || planKey === "yucayeque" || planKey === "cacique";
  const mutation = useMutation({
    mutationFn: () =>
      api.admin.createPayPalPlan(
        planKey as "bohio" | "yucayeque" | "cacique",
        mode,
      ),
    onSuccess: (res) => onCreated(res.planId),
    onError: (err) =>
      onError(err instanceof ApiError ? err.message : (err as Error).message),
  });
  if (!isTier) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      loading={mutation.isPending}
    >
      Create
    </Button>
  );
}

// Stripe CLI hint shown in the sandbox-mode Credentials section. The Stripe
// dashboard webhook secret is only minted for live endpoints; for local dev
// the canonical way to get a sandbox `whsec_…` is `stripe listen`, which
// prints it to stdout. We filter events to the ones billing.ts actually
// dispatches so the dev's CLI isn't flooded with noise.
function StripeListenHint({ provider }: { provider: string }) {
  const [copied, setCopied] = useState(false);
  const cmd = `stripe listen --forward-to localhost:4000/api/billing/webhook/${provider} --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed,invoice.finalized,invoice.voided,invoice.marked_uncollectible`;
  return (
    <div className="cli-hint">
      <p className="cli-hint__title">
        <Info size={12} aria-hidden /> Local sandbox webhooks
      </p>
      <p className="cli-hint__body">
        For sandbox you can grab a <code>whsec_…</code> by running the Stripe
        CLI locally — paste the secret it prints into the field above.
      </p>
      <div className="cli-hint__cmd">
        <code>{cmd}</code>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(cmd);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
