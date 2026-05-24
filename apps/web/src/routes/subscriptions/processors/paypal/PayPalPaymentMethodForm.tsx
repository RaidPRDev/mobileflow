import { Button } from "@mobileflow/ui";
import type { PaymentMethodFormProps } from "../types";

// PayPal can't capture a card inline — we redirect the user to PayPal's
// vault approval page. The backend has already created a v3 vault setup
// token and returned its `approve` link as `redirectUrl`. After approval
// PayPal bounces back to our `/billing/paypal-vault` return URL where the
// SPA exchanges the setup-token for a payment-token.
export function PayPalPaymentMethodForm({ redirectUrl, onCancel }: PaymentMethodFormProps) {
  if (!redirectUrl) {
    return <p className="text-error">PayPal setup did not return an approval URL.</p>;
  }
  return (
    <div className="stack-sm">
      <p className="text-help">
        We&apos;ll send you to PayPal to authorize this account as your billing source.
        After approval you&apos;ll return here automatically.
      </p>
      <div className="row">
        <Button
          onClick={() => {
            window.location.href = redirectUrl;
          }}
        >
          Continue to PayPal
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
