import { Button } from "@mobileflow/ui";
import type { PaymentMethodFormProps } from "../types";

// ConnectPay vaults cards via its own hosted iframe page. We redirect there
// with a setup-intent session created server-side; on completion the user
// lands back on `/billing/connectpay-vault` which finalizes the attach.
export function ConnectPayPaymentMethodForm({ redirectUrl, onCancel }: PaymentMethodFormProps) {
  if (!redirectUrl) {
    return <p className="text-error">ConnectPay did not return a checkout URL.</p>;
  }
  return (
    <div className="stack-sm">
      <p className="text-help">
        We&apos;ll send you to ConnectPay&apos;s secure page to enter your card.
        After saving you&apos;ll return here automatically.
      </p>
      <div className="row">
        <Button
          onClick={() => {
            window.location.href = redirectUrl;
          }}
        >
          Continue to ConnectPay
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
