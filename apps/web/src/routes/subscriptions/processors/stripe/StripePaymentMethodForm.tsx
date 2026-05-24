import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { loadStripe, type Appearance, type Stripe, type StripeElementsOptions } from "@stripe/stripe-js";
import {
  CardCvcElement,
  CardExpiryElement,
  CardNumberElement,
  Elements,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Button, Combobox, Input, cn } from "@mobileflow/ui";
import { api } from "../../../../api/client";
import { useTheme } from "../../../../theme/ThemeProvider";
import { COUNTRIES } from "../../countries";
import type { PaymentMethodFormProps } from "../types";
import { BrandIcon } from "./BrandIcon";

let _stripeP: Promise<Stripe | null> | null = null;
let _stripeKey: string | null = null;
function getStripeP(publishableKey: string): Promise<Stripe | null> {
  // Re-loading Stripe.js whenever the publishable key changes (mode flip in
  // admin, or first-time configuration). Caching by key avoids creating a
  // new Stripe instance on every re-render.
  if (!_stripeP || _stripeKey !== publishableKey) {
    _stripeKey = publishableKey;
    _stripeP = loadStripe(publishableKey);
  }
  return _stripeP;
}

// Element-level styling that mirrors the rest of the app's input styling.
// The container CSS handles layout; per-iframe Stripe Elements only need
// the text color, placeholder, and font.
function buildElementStyle(theme: "light" | "dark") {
  const dark = theme === "dark";
  return {
    base: {
      color: dark ? "#f5f5f5" : "#111",
      fontFamily:
        'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      fontSize: "14px",
      "::placeholder": { color: dark ? "#71717a" : "#9ca3af" },
      iconColor: dark ? "#a1a1aa" : "#6b7280",
    },
    invalid: { color: "#ef4444", iconColor: "#ef4444" },
  };
}

function buildAppearance(theme: "light" | "dark"): Appearance {
  // Appearance is required for Elements() even though we render split
  // elements ourselves. Keep it minimal — most styling comes from elementStyle.
  return theme === "dark" ? { theme: "night" } : { theme: "stripe" };
}

export function StripePaymentMethodForm(props: PaymentMethodFormProps) {
  const { resolved: theme } = useTheme();
  const publishableKey = props.config.publicConfig.publishableKey;
  const clientSecret = props.clientSecret;
  const stripePromise = useMemo(
    () => (publishableKey ? getStripeP(publishableKey) : null),
    [publishableKey],
  );
  const options: StripeElementsOptions = useMemo(
    () => ({
      clientSecret: clientSecret ?? "",
      appearance: buildAppearance(theme),
    }),
    [clientSecret, theme],
  );
  if (!publishableKey) {
    return <p className="text-error">Stripe publishable key is missing.</p>;
  }
  if (!clientSecret) {
    return <p className="text-error">Stripe SetupIntent client secret is missing.</p>;
  }
  if (!stripePromise) return null;
  return (
    <Elements stripe={stripePromise} options={options}>
      <InnerForm {...props} clientSecret={clientSecret} theme={theme} />
    </Elements>
  );
}

function InnerForm({
  orgId,
  clientSecret,
  onSaved,
  onCancel,
  theme,
}: Omit<PaymentMethodFormProps, "clientSecret"> & {
  clientSecret: string;
  theme: "light" | "dark";
}) {
  const stripe = useStripe();
  const elements = useElements();
  const qc = useQueryClient();

  // Element completion state. Drives the progressive-reveal layout:
  //   - When the number is complete, the number field shrinks (showing only
  //     the trailing digits) and expiry+cvc slide in.
  //   - When all three are complete, the "Save with Link" affordance appears.
  // The card brand comes from Stripe's CardNumber change event (`event.brand`).
  const [brand, setBrand] = useState<string>("unknown");
  const [numberComplete, setNumberComplete] = useState(false);
  const [expiryComplete, setExpiryComplete] = useState(false);
  const [cvcComplete, setCvcComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [country, setCountry] = useState("US");
  const [address, setAddress] = useState("");

  const allComplete = numberComplete && expiryComplete && cvcComplete;
  const elementStyle = useMemo(() => buildElementStyle(theme), [theme]);

  const submit = useMutation({
    mutationFn: async () => {
      if (!stripe || !elements) throw new Error("Stripe not ready");
      const cardNumber = elements.getElement(CardNumberElement);
      if (!cardNumber) throw new Error("Card field not mounted");
      // For split-element forms we call confirmCardSetup directly with the
      // CardNumberElement reference — Stripe links the related expiry/cvc
      // iframes automatically since they share the same Elements instance.
      const result = await stripe.confirmCardSetup(clientSecret, {
        payment_method: {
          card: cardNumber,
          billing_details: {
            name: fullName || undefined,
            address: {
              country: country || undefined,
              line1: address || undefined,
            },
          },
        },
      });
      if (result.error) throw new Error(result.error.message ?? "Card setup failed");
      const pmId =
        typeof result.setupIntent?.payment_method === "string"
          ? result.setupIntent.payment_method
          : result.setupIntent?.payment_method?.id;
      if (!pmId) throw new Error("No payment method returned");
      await api.attachPaymentMethod(orgId, pmId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payment-method", orgId] });
      onSaved();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Card setup failed"),
  });

  // Some browsers paint the just-mounted iframe at 0×0 for a frame; force a
  // layout once we know the number has completed so the slide animation
  // doesn't start from a stale measurement.
  useEffect(() => {
    if (numberComplete) {
      // no-op — React commits the class change which triggers the transition
    }
  }, [numberComplete]);

  return (
    <div className="stack-sm">
      <div className="settings-field">
        <label className="settings-field__label">Card information</label>
        <div className={cn("card-row", numberComplete && "is-expanded", allComplete && "is-complete")}>
          <span className="card-row__brand" aria-hidden>
            <BrandIcon brand={brand} />
          </span>
          <div className="card-row__number">
            <CardNumberElement
              options={{
                style: elementStyle,
                showIcon: false,
                placeholder: "Card number",
              }}
              onChange={(e) => {
                setBrand(e.brand ?? "unknown");
                setNumberComplete(e.complete);
              }}
            />
          </div>
          <div className="card-row__expiry">
            <CardExpiryElement
              options={{ style: elementStyle, placeholder: "MM / YY" }}
              onChange={(e) => setExpiryComplete(e.complete)}
            />
          </div>
          <div className="card-row__cvc">
            <CardCvcElement
              options={{ style: elementStyle, placeholder: "CVC" }}
              onChange={(e) => setCvcComplete(e.complete)}
            />
          </div>
          {allComplete && (
            <span className="card-row__save-link" aria-hidden>
              Save with <strong>link</strong>
            </span>
          )}
        </div>
      </div>

      <fieldset className="billing-address-group">
        <legend className="billing-address-group__legend">Billing address</legend>
        <div className="settings-field">
          <label className="settings-field__label" htmlFor="pm-name">
            Full name
          </label>
          <Input id="pm-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="settings-field">
          <label className="settings-field__label">Country or region</label>
          <Combobox
            value={country}
            onChange={setCountry}
            options={COUNTRIES.map((c) => ({ value: c.code, label: c.name }))}
            ariaLabel="Country or region"
          />
        </div>
        <div className="settings-field">
          <label className="settings-field__label" htmlFor="pm-address">
            Address
          </label>
          <Input id="pm-address" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
      </fieldset>

      {error && <p className="text-error">{error}</p>}

      <div className="row">
        <Button
          onClick={() => submit.mutate()}
          disabled={!stripe || !elements || submit.isPending || !allComplete}
          loading={submit.isPending}
        >
          Update Card
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={submit.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
