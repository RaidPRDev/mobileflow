import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadStripe, type Appearance, type Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { Button, Combobox, Input } from "@mobileflow/ui";
import { ApiError, api } from "../../api/client";
import { useTheme } from "../../theme/ThemeProvider";
import { COUNTRIES } from "./countries";

let _stripeP: Promise<Stripe | null> | null = null;
function getStripeP(publishableKey: string): Promise<Stripe | null> {
  if (!_stripeP) _stripeP = loadStripe(publishableKey);
  return _stripeP;
}

function buildStripeAppearance(theme: "light" | "dark"): Appearance {
  if (theme === "dark") {
    return {
      theme: "night",
      variables: {
        colorPrimary: "#3b82f6",
        colorBackground: "#131316",
        colorText: "#f5f5f5",
        colorTextSecondary: "#a1a1aa",
        colorTextPlaceholder: "#71717a",
        colorDanger: "#ef4444",
        colorIconTab: "#a1a1aa",
        colorIconTabSelected: "#f5f5f5",
        borderRadius: "8px",
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      },
      rules: {
        ".Input": {
          backgroundColor: "#131316",
          border: "1px solid #2a2a2e",
          color: "#f5f5f5",
        },
        ".Input:focus": {
          border: "1px solid #3b82f6",
          boxShadow: "0 0 0 1px #3b82f6",
        },
        ".Label": { color: "#a1a1aa" },
      },
    };
  }
  return {
    theme: "stripe",
    variables: {
      colorPrimary: "#2563eb",
      fontFamily:
        'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      borderRadius: "8px",
    },
  };
}

interface Props {
  orgId: string;
  onSaved: () => void;
  onCancel: () => void;
}

export function PaymentMethodForm({ orgId, onSaved, onCancel }: Props) {
  const { resolved: theme } = useTheme();
  const cfgQ = useQuery({
    queryKey: ["billing-config"],
    queryFn: () => api.getBillingConfig(),
    staleTime: Infinity,
  });
  const intentQ = useQuery({
    queryKey: ["setup-intent", orgId],
    queryFn: () => api.createSetupIntent(orgId),
  });

  const stripePromise = useMemo(() => {
    const pk = cfgQ.data?.publishableKey;
    return pk ? getStripeP(pk) : null;
  }, [cfgQ.data?.publishableKey]);

  const appearance = useMemo(
    () => buildStripeAppearance(theme),
    [theme],
  );

  if (cfgQ.isLoading || intentQ.isLoading) {
    return <p className="text-help">Loading…</p>;
  }
  if (!cfgQ.data?.publishableKey) {
    return <p className="text-error">Stripe is not configured.</p>;
  }
  if (intentQ.error || !intentQ.data?.clientSecret) {
    return (
      <p className="text-error">
        {intentQ.error instanceof ApiError
          ? intentQ.error.message
          : "Could not start payment setup."}
      </p>
    );
  }
  if (!stripePromise) return null;

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: intentQ.data.clientSecret,
        appearance,
      }}
    >
      <InnerForm orgId={orgId} onSaved={onSaved} onCancel={onCancel} />
    </Elements>
  );
}

function InnerForm({ orgId, onSaved, onCancel }: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const qc = useQueryClient();
  const [fullName, setFullName] = useState("");
  const [country, setCountry] = useState("US");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      if (!stripe || !elements) throw new Error("Stripe not ready");
      const result = await stripe.confirmSetup({
        elements,
        confirmParams: {
          payment_method_data: {
            billing_details: {
              name: fullName || undefined,
              address: {
                country: country || undefined,
                line1: address || undefined,
              },
            },
          },
        },
        redirect: "if_required",
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

  return (
    <div className="stack-sm">
      <div className="settings-field">
        <label className="settings-field__label">Card information</label>
        <div className="payment-element-wrap">
          <PaymentElement options={{ wallets: { applePay: "auto", googlePay: "auto", link: "never" } }} />
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
          disabled={!stripe || !elements || submit.isPending}
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
